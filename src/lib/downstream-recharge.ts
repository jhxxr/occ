import { prisma } from "@/lib/db";
import { listDownstreamUsersForSite } from "@/lib/downstream-fetch";

/**
 * Refresh the complete downstream balance snapshot used by prepaid liability.
 * This function deliberately does not mutate remote quota.
 */
export async function syncDownstreamUserBalances(siteId: string) {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  if (!site) throw new Error("站点不存在");
  const observedAt = new Date();
  const result = await listDownstreamUsersForSite(site);
  if (!result.success || !result.complete) {
    const error = result.error || `用户列表不完整（${result.scanned}/${result.total || "?"}）`;
    await prisma.downstreamSite.update({
      where: { id: siteId },
      data: { balanceSyncError: error },
    });
    throw new Error(error);
  }

  // 整段重建：这张表是远端用户余额的快照，没有本地手填字段。
  // 原来是 updateMany + 逐个 upsert + deleteMany，逐行 upsert 在远端库上
  // 实测 ~692ms/行；改成 deleteMany + createMany 后是 ~7ms/行，落库的值不变。
  //
  // 拉取不完整时上面已经抛错返回，走到这里的一定是完整列表，所以整表替换是
  // 安全的 —— 顺带也把远端已删除的用户清掉（原来靠 deleteMany 做同一件事）。
  await prisma.$transaction([
    prisma.downstreamUserBalance.deleteMany({ where: { downstreamId: siteId } }),
    prisma.downstreamUserBalance.createMany({
      data: result.users.map((user) => ({
        downstreamId: siteId,
        userId: user.id,
        username: user.username,
        role: user.role,
        quota: user.quota,
        usedQuota: user.used_quota,
        observedAt,
        complete: true,
      })),
    }),
    prisma.downstreamSite.update({
      where: { id: siteId },
      data: { balanceLastSyncAt: observedAt, balanceSyncError: null },
    }),
  ]);
  return { site, users: result.users, observedAt };
}
