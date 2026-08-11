import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { fetchDownstreamDailyUserUsage, listDownstreamUsers } from "@/lib/adapters";
import { shanghaiDay } from "@/lib/reporting-period";

const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

type Ownership = "EXCLUDED" | "PRIVATE" | "PUBLIC";

function parseIds(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value || "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.map(Number).filter((id) => Number.isFinite(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

function ownershipForUser(
  userId: number,
  excluded: Set<number>,
  privateUsers: Set<number>,
): Ownership {
  if (excluded.has(userId)) return "EXCLUDED";
  return privateUsers.has(userId) ? "PRIVATE" : "PUBLIC";
}

/**
 * Allocate only zero-cash gift credits against user consumption.
 *
 * Downstream usage is available at day granularity, so a redemption and usage
 * within the same Shanghai day cannot be ordered reliably. The ledger uses a
 * documented daily convention: a redeemed gift is available for that whole
 * reporting day. This may move revenue within that day, but it prevents an
 * unconsumed gift remainder from incorrectly reducing a later paid day.
 *
 * Ordinary paid consumption keeps the existing daily revenue facts, so the
 * ledger does not need to reconstruct every historical cash recharge.
 */
export async function syncManagedCreditLedger(
  downstreamId: string,
): Promise<{
  success: boolean;
  allocations: number;
  recognizedRmb: number;
  bonusQuota: number;
  error?: string;
}> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: downstreamId } });
  if (!site) {
    return {
      success: false,
      allocations: 0,
      recognizedRmb: 0,
      bonusQuota: 0,
      error: "站点不存在",
    };
  }

  const giftLots = await prisma.downstreamCreditLot.findMany({
    where: {
      downstreamId,
      source: { in: ["ADMIN_BONUS", "REDEEM_CODE"] },
      originalQuota: { gt: 0 },
    },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (!giftLots.length) {
    return { success: true, allocations: 0, recognizedRmb: 0, bonusQuota: 0 };
  }

  const users = await listDownstreamUsers({
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId,
    quotaPerDollar: site.quotaPerDollar,
  });
  if (!users.success || !users.complete) {
    return {
      success: false,
      allocations: 0,
      recognizedRmb: 0,
      bonusQuota: 0,
      error: users.error || "用户列表不完整",
    };
  }

  const startDay = giftLots.reduce(
    (earliest, lot) => {
      const day = shanghaiDay(lot.occurredAt);
      return day < earliest ? day : earliest;
    },
    shanghaiDay(giftLots[0]!.occurredAt),
  );
  const today = shanghaiDay();
  const replayEnd = new Date(`${today}T00:00:00+08:00`);
  replayEnd.setUTCDate(replayEnd.getUTCDate() - 1);
  const replayStartDay = startDay;
  const endDay = shanghaiDay(replayEnd);
  if (endDay < replayStartDay) {
    return { success: true, allocations: 0, recognizedRmb: 0, bonusQuota: 0 };
  }

  const usage = await fetchDownstreamDailyUserUsage({
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId,
    startDay: replayStartDay,
    endDay,
  });
  if (!usage.success || !usage.complete) {
    return {
      success: false,
      allocations: 0,
      recognizedRmb: 0,
      bonusQuota: 0,
      error: usage.error || "逐用户消费不完整",
    };
  }

  const userIdByName = new Map(users.users.map((user) => [user.username, user.id]));
  const excluded = parseIds(site.excludeUserIds);
  const privateUsers = parseIds(site.privateUserIds);
  const rows = usage.rows
    .filter((row) => row.day >= replayStartDay && row.day <= endDay && row.quota > 0)
    .sort((a, b) => {
      const day = a.day.localeCompare(b.day);
      return day || a.username.localeCompare(b.username);
    });

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM DownstreamSite WHERE id = ${downstreamId} FOR UPDATE`;
        const currentLots = await tx.downstreamCreditLot.findMany({
          where: {
            downstreamId,
            source: { in: ["ADMIN_BONUS", "REDEEM_CODE"] },
            originalQuota: { gt: 0 },
          },
          orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        });
        await tx.downstreamCreditAllocation.deleteMany({
          where: {
            downstreamId,
            source: { in: ["ADMIN_BONUS", "REDEEM_CODE"] },
          },
        });

        const lotsByUser = new Map<number, typeof currentLots>();
        const remainingByLot = new Map<string, number>();
        for (const lot of currentLots) {
          const list = lotsByUser.get(lot.userId) || [];
          list.push(lot);
          lotsByUser.set(lot.userId, list);
          remainingByLot.set(lot.id, lot.originalQuota);
        }

        const totals = new Map<
          string,
          {
            downstreamId: string;
            userId: number;
            lotId: string;
            day: string;
            ownership: Ownership;
            consumedQuota: number;
            recognizedRmb: number;
            source: string;
          }
        >();
        let allocations = 0;
        let bonusQuota = 0;

        for (const row of rows) {
          const userId = userIdByName.get(row.username);
          if (!userId) continue;
          let remainingUsage = row.quota;
          const ownership = ownershipForUser(userId, excluded, privateUsers);
          for (const lot of lotsByUser.get(userId) || []) {
            if (!(remainingUsage > 0)) break;
            if (row.day < shanghaiDay(lot.occurredAt)) continue;
            const lotRemaining = remainingByLot.get(lot.id) || 0;
            if (!(lotRemaining > 0)) continue;
            const consumedQuota = Math.min(remainingUsage, lotRemaining);
            const key = `${lot.id}|${row.day}|${ownership}`;
            const total = totals.get(key) || {
              downstreamId,
              userId,
              lotId: lot.id,
              day: row.day,
              ownership,
              consumedQuota: 0,
              recognizedRmb: 0,
              source: lot.source,
            };
            total.consumedQuota += consumedQuota;
            totals.set(key, total);
            remainingByLot.set(lot.id, lotRemaining - consumedQuota);
            remainingUsage -= consumedQuota;
            allocations++;
            bonusQuota += consumedQuota;
          }
        }

        for (const lot of currentLots) {
          await tx.downstreamCreditLot.update({
            where: { id: lot.id },
            data: { remainingQuota: remainingByLot.get(lot.id) || 0 },
          });
        }
        for (const total of totals.values()) {
          await tx.downstreamCreditAllocation.create({ data: total });
        }

        return {
          success: true,
          allocations,
          recognizedRmb: 0,
          bonusQuota,
        };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    return {
      success: false,
      allocations: 0,
      recognizedRmb: 0,
      bonusQuota: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
