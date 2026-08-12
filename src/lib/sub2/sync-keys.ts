/**
 * Sync Sub2API keys + per-key actual cost, for precise mid-station COGS.
 * Only keys with countAsCost=true contribute to business consumption delta.
 *
 * 成本增量靠「上次的 totalActualCost」做基线，所以基线绝不能被猜测值覆盖：
 * 用量接口没返回某个 Key 时（部分失败 / 字段改名 / 该 Key 无记录），
 * 保留原基线并计 0 增量 —— 一旦写成 0，下次同步就会把全部历史消费
 * 当成「本轮新增」再记一次成本（凭空多出一大笔钱）。
 */

import { prisma } from "@/lib/db";
import { listKeys, fetchKeyUsageStats } from "@/lib/sub2/client";
import { withSyncLock } from "@/lib/sync-lock";

export interface KeyCostSyncResult {
  keys: number;
  billableKeys: number;
  /** 本轮「计入中转」Key 的实际扣费增量（美元面值） */
  businessDeltaUsd: number;
  /** 账号全部 Key 的实际扣费增量（美元面值，仅供参考） */
  fullDeltaUsd: number;
  totalBusinessUsd: number;
  /** 用量接口没给出数据、基线被保留的 Key 数（>0 表示本轮成本可能偏低） */
  missingStats: number;
  /** 上游累计消费比基线还低的 Key 数（对方重置过计数器） */
  baselineResets: number;
}

/** 一次最多翻几页 Key（每页 100） */
const MAX_KEY_PAGES = 20;

export async function syncSub2ApiKeys(
  providerId: string,
): Promise<KeyCostSyncResult> {
  // 这个函数会推进每条 Key 的累计消费基线。它不只从全量同步进入，
  // 管理页和使用记录页也会调用；锁必须放在这里才能覆盖所有入口。
  return withSyncLock("upstream", providerId, () =>
    runSub2ApiKeysSync(providerId),
  );
}

async function runSub2ApiKeysSync(
  providerId: string,
): Promise<KeyCostSyncResult> {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
    select: { retiredAt: true },
  });
  if (!provider) throw new Error("上游不存在");
  if (provider.retiredAt) {
    throw new Error("该上游已弃用，只能查询本地历史，不能继续远端同步");
  }

  // Key 可能超过一页；漏掉的 Key 会被当成「远端已删除」，增量永久丢失
  const items = [];
  for (let page = 1; page <= MAX_KEY_PAGES; page++) {
    const remote = await listKeys(providerId, { page, pageSize: 100 });
    const batch = remote.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  const ids = items.map((k) => k.id);

  const usage = await fetchKeyUsageStats(providerId, ids);
  const existing = await prisma.upstreamApiKey.findMany({
    where: { providerId },
  });
  const byRemote = new Map(existing.map((e) => [e.remoteKeyId, e]));

  let businessDeltaUsd = 0;
  let fullDeltaUsd = 0;
  let billableKeys = 0;
  let totalBusinessUsd = 0;
  let missingStats = 0;
  let baselineResets = 0;

  const seen = new Set<string>();

  for (const k of items) {
    const remoteId = String(k.id);
    seen.add(remoteId);
    const stat = usage[remoteId];
    const reported = Number(stat?.total_actual_cost);
    // 没有可用数字就是「这轮不知道」，不是「花了 0」
    const hasStat = stat != null && Number.isFinite(reported);
    const prev = byRemote.get(remoteId);
    const prevTotal = prev?.totalActualCost ?? null;

    // 基线只在拿到真实数字时推进；拿不到就沿用旧值
    const totalActual = hasStat ? reported : (prevTotal ?? 0);
    const todayReported = Number(stat?.today_actual_cost);
    const todayActual = Number.isFinite(todayReported) ? todayReported : null;

    if (!hasStat) missingStats++;
    if (hasStat && prevTotal != null && reported < prevTotal) baselineResets++;

    // 首次见到该 key：只建基线，不计入增量成本
    const delta =
      prevTotal == null || !hasStat ? 0 : Math.max(0, totalActual - prevTotal);
    fullDeltaUsd += delta;

    const countAsCost = prev?.countAsCost ?? false;
    if (countAsCost) {
      billableKeys++;
      businessDeltaUsd += delta;
      totalBusinessUsd += totalActual;
    }

    const group = k.group;
    const costPatch = hasStat
      ? {
          totalActualCost: totalActual,
          ...(todayActual != null ? { todayActualCost: todayActual } : {}),
        }
      : {};

    await prisma.upstreamApiKey.upsert({
      where: {
        providerId_remoteKeyId: { providerId, remoteKeyId: remoteId },
      },
      create: {
        providerId,
        remoteKeyId: remoteId,
        name: k.name || "",
        keyPreview: k.key
          ? `${k.key.slice(0, 6)}…${k.key.slice(-4)}`
          : "",
        groupId: k.group_id ?? group?.id ?? null,
        groupName: group?.name ?? null,
        rateMultiplier: group?.rate_multiplier ?? null,
        status: k.status || "active",
        countAsCost: false,
        totalActualCost: totalActual,
        todayActualCost: todayActual ?? 0,
        lastSyncAt: new Date(),
      },
      update: {
        name: k.name || "",
        keyPreview: k.key
          ? `${k.key.slice(0, 6)}…${k.key.slice(-4)}`
          : "",
        groupId: k.group_id ?? group?.id ?? null,
        groupName: group?.name ?? null,
        rateMultiplier: group?.rate_multiplier ?? null,
        status: k.status || "active",
        ...costPatch,
        lastSyncAt: new Date(),
      },
    });
  }

  // 远端已删除的 key：保留本地记录但可标记 —— 暂不删，避免丢归因历史
  for (const e of existing) {
    if (!seen.has(e.remoteKeyId) && e.countAsCost) {
      billableKeys++;
      totalBusinessUsd += e.totalActualCost;
    }
  }

  await prisma.upstreamProvider.update({
    where: { id: providerId },
    data: { lastBusinessConsumed: totalBusinessUsd },
  });

  return {
    keys: items.length,
    billableKeys,
    businessDeltaUsd,
    fullDeltaUsd,
    totalBusinessUsd,
    missingStats,
    baselineResets,
  };
}
