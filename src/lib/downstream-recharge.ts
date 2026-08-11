import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { listDownstreamUsers } from "@/lib/adapters";

function parseIds(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

/**
 * Refresh the complete downstream balance snapshot used by prepaid liability.
 * This function deliberately does not mutate remote quota.
 */
export async function syncDownstreamUserBalances(siteId: string) {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  if (!site) throw new Error("站点不存在");
  const observedAt = new Date();
  const excludeUserIds = [...parseIds(site.excludeUserIds)];
  const privateUserIds = [...parseIds(site.privateUserIds)];
  const result = await listDownstreamUsers({
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId,
    quotaPerDollar: site.quotaPerDollar,
    excludeUserIds,
    privateUserIds,
  });
  if (!result.success || !result.complete) {
    const error = result.error || `用户列表不完整（${result.scanned}/${result.total || "?"}）`;
    await prisma.downstreamSite.update({
      where: { id: siteId },
      data: { balanceSyncError: error },
    });
    throw new Error(error);
  }

  const currentIds = result.users.map((user) => user.id);
  await prisma.$transaction([
    prisma.downstreamUserBalance.updateMany({
      where: { downstreamId: siteId },
      data: { complete: false },
    }),
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
    prisma.downstreamUserBalance.deleteMany({
      where: {
        downstreamId: siteId,
        userId: { notIn: currentIds.length ? currentIds : [-1] },
      },
    }),
    prisma.downstreamSite.update({
      where: { id: siteId },
      data: { balanceLastSyncAt: observedAt, balanceSyncError: null },
    }),
  ]);
  return { site, users: result.users, observedAt };
}
