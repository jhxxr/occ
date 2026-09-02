import { prisma } from "@/lib/db";
import {
  fetchDownstreamDailyUserUsageForSite,
  listDownstreamUsersForSite,
} from "@/lib/downstream-fetch";
import { shanghaiDay } from "@/lib/reporting-period";
import {
  classifyPrepaidUser,
  type PrepaidUserOwnership,
} from "@/lib/prepaid";

const TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;
const CASH_SOURCES = new Set(["PRIVATE_DIRECT", "GIFT_CARD_SALE"]);

function parseIds(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

function sourcePriority(source: string): number {
  // The owner always consumes their directly collected money before shared card money.
  if (source === "PRIVATE_DIRECT") return 0;
  if (source === "GIFT_CARD_SALE") return 1;
  return 2;
}

/**
 * Rebuild funding allocations from daily per-user consumption.
 * Cash is recognized only when its recorded funding lot is consumed. Private direct
 * lots are always consumed before public gift-card lots for the same user.
 */
export async function syncManagedCreditLedger(
  downstreamId: string,
): Promise<{ success: boolean; allocations: number; recognizedRmb: number; bonusQuota: number; error?: string }> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: downstreamId } });
  if (!site) return { success: false, allocations: 0, recognizedRmb: 0, bonusQuota: 0, error: "站点不存在" };

  const lots = await prisma.downstreamCreditLot.findMany({
    where: { downstreamId, originalQuota: { gt: 0 }, userId: { not: null } },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (!lots.length) return { success: true, allocations: 0, recognizedRmb: 0, bonusQuota: 0 };

  const users = await listDownstreamUsersForSite(site);
  if (!users.success || !users.complete) {
    return { success: false, allocations: 0, recognizedRmb: 0, bonusQuota: 0, error: users.error || "用户列表不完整" };
  }

  const startDay = lots.reduce(
    (earliest, lot) => Math.min(earliest, lot.occurredAt.getTime()),
    lots[0]!.occurredAt.getTime(),
  );
  const usage = await fetchDownstreamDailyUserUsageForSite(site, {
    startDay: shanghaiDay(new Date(startDay)),
    endDay: shanghaiDay(),
  });
  if (!usage.success || !usage.complete) {
    return { success: false, allocations: 0, recognizedRmb: 0, bonusQuota: 0, error: usage.error || "逐用户消费不完整" };
  }

  const userByName = new Map(users.users.map((user) => [user.username, { id: user.id, role: user.role }]));
  const excluded = parseIds(site.excludeUserIds);
  const privateUsers = parseIds(site.privateUserIds);
  const rows = usage.rows
    .filter((row) => row.quota > 0)
    .sort((a, b) => a.day.localeCompare(b.day) || a.username.localeCompare(b.username));

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM DownstreamSite WHERE id = ${downstreamId} FOR UPDATE`;
      const currentLots = await tx.downstreamCreditLot.findMany({
        where: { downstreamId, originalQuota: { gt: 0 }, userId: { not: null } },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      await tx.downstreamCreditAllocation.deleteMany({ where: { downstreamId } });

      const byUser = new Map<number, typeof currentLots>();
      const remaining = new Map<string, number>();
      for (const lot of currentLots) {
        if (lot.userId == null) continue;
        const list = byUser.get(lot.userId) || [];
        list.push(lot);
        byUser.set(lot.userId, list);
        remaining.set(lot.id, lot.originalQuota);
      }
      for (const list of byUser.values()) {
        list.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source)
          || a.occurredAt.getTime() - b.occurredAt.getTime()
          || a.id.localeCompare(b.id));
      }

      const totals = new Map<string, {
        downstreamId: string; userId: number; lotId: string; day: string;
        ownership: string; consumedQuota: number; recognizedRmb: number; source: string;
      }>();
      let allocations = 0;
      let recognizedRmb = 0;
      let bonusQuota = 0;

      for (const row of rows) {
        const user = userByName.get(row.username);
        if (!user) continue;
        const userOwnership = classifyPrepaidUser(user.id, user.role, {
          excludeUserIds: excluded,
          privateUserIds: privateUsers,
        });
        // Test/admin consumption is deliberately not allocated as revenue. Its cost is
        // reported separately from model usage, never charged to the public pool.
        if (userOwnership === "EXCLUDED") continue;

        let unallocated = row.quota;
        for (const lot of byUser.get(user.id) || []) {
          if (!(unallocated > 0) || row.day < shanghaiDay(lot.occurredAt)) continue;
          const lotRemaining = remaining.get(lot.id) || 0;
          if (!(lotRemaining > 0)) continue;
          const consumedQuota = Math.min(unallocated, lotRemaining);
          const isCash = CASH_SOURCES.has(lot.source) && lot.cashBasisRmb != null;
          const ownership = lot.ownership === "PRIVATE" ? "PRIVATE" : lot.ownership === "PUBLIC" ? "PUBLIC" : userOwnership;
          const recognized = isCash
            ? consumedQuota / lot.originalQuota * Math.max(0, lot.cashBasisRmb || 0)
            : 0;
          const key = `${lot.id}|${row.day}|${ownership}`;
          const total = totals.get(key) || {
            downstreamId, userId: user.id, lotId: lot.id, day: row.day, ownership,
            consumedQuota: 0, recognizedRmb: 0, source: lot.source,
          };
          total.consumedQuota += consumedQuota;
          total.recognizedRmb += recognized;
          totals.set(key, total);
          remaining.set(lot.id, lotRemaining - consumedQuota);
          unallocated -= consumedQuota;
          allocations++;
          recognizedRmb += recognized;
          if (!isCash) bonusQuota += consumedQuota;
        }
      }

      for (const lot of currentLots) {
        await tx.downstreamCreditLot.update({ where: { id: lot.id }, data: { remainingQuota: remaining.get(lot.id) || 0 } });
      }
      for (const total of totals.values()) {
        total.recognizedRmb = Math.round(total.recognizedRmb * 100) / 100;
        await tx.downstreamCreditAllocation.create({ data: total });
      }
      return { success: true, allocations, recognizedRmb: Math.round(recognizedRmb * 100) / 100, bonusQuota };
    }, { timeout: TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    return { success: false, allocations: 0, recognizedRmb: 0, bonusQuota: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
