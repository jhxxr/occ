/**
 * Sync Sub2API keys + per-key actual cost, for precise mid-station COGS.
 * Only keys with countAsCost=true contribute to business consumption delta.
 */

import { prisma } from "@/lib/db";
import { listKeys, fetchKeyUsageStats } from "@/lib/sub2/client";

export interface KeyCostSyncResult {
  keys: number;
  billableKeys: number;
  /** 本轮「计入中转」Key 的实际扣费增量（美元面值） */
  businessDeltaUsd: number;
  /** 账号全部 Key 的实际扣费增量（美元面值，仅供参考） */
  fullDeltaUsd: number;
  totalBusinessUsd: number;
}

export async function syncSub2ApiKeys(
  providerId: string,
): Promise<KeyCostSyncResult> {
  const remote = await listKeys(providerId, { pageSize: 100 });
  const items = remote.items || [];
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

  const seen = new Set<string>();

  for (const k of items) {
    const remoteId = String(k.id);
    seen.add(remoteId);
    const stat = usage[remoteId] || usage[String(k.id)];
    const totalActual = Number(stat?.total_actual_cost ?? 0);
    const todayActual = Number(stat?.today_actual_cost ?? 0);
    const prev = byRemote.get(remoteId);
    const prevTotal = prev?.totalActualCost ?? null;

    // 首次见到该 key：只建基线，不计入增量成本
    const delta =
      prevTotal == null ? 0 : Math.max(0, totalActual - prevTotal);
    fullDeltaUsd += delta;

    const countAsCost = prev?.countAsCost ?? false;
    if (countAsCost) {
      billableKeys++;
      businessDeltaUsd += delta;
      totalBusinessUsd += totalActual;
    }

    const group = k.group;
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
        todayActualCost: todayActual,
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
        totalActualCost: totalActual,
        todayActualCost: todayActual,
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
  };
}
