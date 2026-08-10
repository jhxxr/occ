import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { addDownstreamUserQuota, listDownstreamUsers } from "@/lib/adapters";

function parseIds(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

export async function syncDownstreamUserBalances(siteId: string) {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  if (!site) throw new Error("站点不存在");
  const observedAt = new Date();
  const excludeUserIds = [...parseIds(site.excludeUserIds)];
  const privateUserIds = [...parseIds(site.privateUserIds)];
  const input = {
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId,
    quotaPerDollar: site.quotaPerDollar,
    excludeUserIds,
    privateUserIds,
  };
  const result = await listDownstreamUsers(input);
  if (!result.success) {
    await prisma.downstreamSite.update({
      where: { id: siteId },
      data: { balanceSyncError: result.error },
    });
    throw new Error(result.error);
  }
  await prisma.$transaction([
    ...result.users.map((user) =>
      prisma.downstreamUserBalance.upsert({
        where: { downstreamId_userId: { downstreamId: siteId, userId: user.id } },
        create: {
          downstreamId: siteId,
          userId: user.id,
          username: user.username,
          role: user.role,
          quota: user.quota,
          usedQuota: user.used_quota,
          observedAt,
        },
        update: {
          username: user.username,
          role: user.role,
          quota: user.quota,
          usedQuota: user.used_quota,
          observedAt,
          complete: true,
        },
      }),
    ),
    prisma.downstreamSite.update({
      where: { id: siteId },
      data: { balanceLastSyncAt: observedAt, balanceSyncError: null },
    }),
  ]);
  return { site, users: result.users, observedAt };
}

export async function createManagedRecharge(input: {
  downstreamId: string;
  userId: number;
  paidRmb: number;
  creditedRmb: number;
  idempotencyKey: string;
  operator: string;
  note?: string;
}) {
  const existing = await prisma.downstreamRechargeOperation.findUnique({
    where: {
      downstreamId_idempotencyKey: {
        downstreamId: input.downstreamId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) return existing;

  if (!(input.paidRmb >= 0) || !(input.creditedRmb > 0)) throw new Error("充值金额无效");
  if (input.paidRmb > input.creditedRmb) throw new Error("实收金额不能大于到账面值");

  const { site, users } = await syncDownstreamUserBalances(input.downstreamId);
  const user = users.find((row) => row.id === input.userId);
  if (!user) throw new Error("用户不存在");
  const excluded = parseIds(site.excludeUserIds);
  if (user.role >= 100 || excluded.has(user.id)) throw new Error("测试号或超管不能通过此界面充值");
  if (user.status != null && user.status !== 1) throw new Error("用户当前不可用");

  const quotaPerDollar = site.quotaPerDollar || 500_000;
  const creditedQuota = Math.round(input.creditedRmb * quotaPerDollar);
  const operation = await prisma.downstreamRechargeOperation.create({
    data: {
      downstreamId: site.id,
      userId: user.id,
      idempotencyKey: input.idempotencyKey,
      paidRmb: input.paidRmb,
      creditedRmb: input.creditedRmb,
      creditedQuota,
      bonusRmb: input.creditedRmb - input.paidRmb,
      quotaPerDollar,
      balanceBefore: user.quota,
      status: "DISPATCHING",
      note: input.note || null,
      operator: input.operator,
    },
  });

  const remote = await addDownstreamUserQuota(
    {
      baseUrl: site.baseUrl,
      adminKey: decryptSecret(site.adminKey),
      adminUserId: site.adminUserId,
      quotaPerDollar,
    },
    user.id,
    creditedQuota,
  );
  if (!remote.success) {
    return prisma.downstreamRechargeOperation.update({
      where: { id: operation.id },
      data: {
        status: remote.ambiguous ? "VERIFY_REQUIRED" : "FAILED",
        error: remote.error,
        remoteRaw: remote.raw ? JSON.stringify(remote.raw).slice(0, 8000) : null,
      },
    });
  }

  const refreshed = await listDownstreamUsers({
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId,
    quotaPerDollar,
  });
  const after = refreshed.success ? refreshed.users.find((row) => row.id === user.id) : null;
  if (!after || after.quota < user.quota + creditedQuota) {
    return prisma.downstreamRechargeOperation.update({
      where: { id: operation.id },
      data: {
        status: "VERIFY_REQUIRED",
        error: "远端返回成功，但余额增量尚未核实",
        remoteRaw: remote.raw ? JSON.stringify(remote.raw).slice(0, 8000) : null,
      },
    });
  }

  const bonusQuota = Math.round((input.creditedRmb - input.paidRmb) * quotaPerDollar);
  const cashQuota = creditedQuota - bonusQuota;
  const now = new Date();
  const updates = [
    prisma.downstreamRechargeOperation.update({
      where: { id: operation.id },
      data: {
        status: "APPLIED",
        balanceAfter: after.quota,
        remoteRaw: remote.raw ? JSON.stringify(remote.raw).slice(0, 8000) : null,
      },
    }),
    prisma.downstreamUserBalance.upsert({
      where: { downstreamId_userId: { downstreamId: site.id, userId: user.id } },
      create: {
        downstreamId: site.id,
        userId: user.id,
        username: user.username,
        role: user.role,
        quota: after.quota,
        usedQuota: after.used_quota,
        observedAt: now,
      },
      update: { quota: after.quota, usedQuota: after.used_quota, observedAt: now },
    }),
  ];
  if (cashQuota > 0) {
    updates.push(prisma.downstreamCreditLot.create({
      data: {
        downstreamId: site.id,
        userId: user.id,
        operationId: operation.id,
        source: "ADMIN_CASH",
        originalQuota: cashQuota,
        remainingQuota: cashQuota,
        cashBasisRmb: input.paidRmb,
        occurredAt: now,
      },
    }) as never);
  }
  if (bonusQuota > 0) {
    updates.push(prisma.downstreamCreditLot.create({
      data: {
        downstreamId: site.id,
        userId: user.id,
        operationId: operation.id,
        source: "ADMIN_BONUS",
        originalQuota: bonusQuota,
        remainingQuota: bonusQuota,
        cashBasisRmb: 0,
        occurredAt: now,
      },
    }) as never);
  }
  await prisma.$transaction(updates);
  return prisma.downstreamRechargeOperation.findUniqueOrThrow({ where: { id: operation.id } });
}
