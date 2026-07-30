/**
 * 旧渠道成本补录
 *
 * 渠道从 NewAPI 删掉之后，日志里的消费还在，但 Orbit 这边找不到对应的上游
 * 成本记录 —— 这段消费会让毛利虚高。这里负责：
 *
 * 1. 检测：翻消费日志按渠道归并，比对存活渠道列表，把删掉的挑出来
 * 2. 补录：你手工填成本（按倍率或直接填总额），填完计入报表成本
 *
 * 检测是幂等的：重复跑只更新消费量与区间，你填过的成本不会被覆盖。
 */

import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { fetchDownstreamChannelUsage } from "@/lib/adapters";
import { assertDay, inclusiveDays, overlapDays } from "@/lib/reporting-period";

const DEFAULT_QUOTA_PER_UNIT = 500_000;

export const ORPHAN_COST_MODE = {
  /** 按购入成本率折算 */
  rate: "RATE",
  /** 直接填这段时间的总成本 */
  amount: "AMOUNT",
} as const;

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** 一条旧渠道记录当前应计的成本（人民币） */
export function orphanCostRmb(row: {
  costMode: string;
  costRate: number | null;
  costAmountRmb: number | null;
  quota: number;
  quotaPerUnit: number;
  ignored: boolean;
}): number {
  if (row.ignored) return 0;
  if (row.costMode === ORPHAN_COST_MODE.amount) {
    return round2(row.costAmountRmb ?? 0);
  }
  if (row.costRate == null) return 0;
  const unit = row.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT;
  return round2((row.quota / unit) * row.costRate);
}

export interface OrphanDetectResult {
  id: string;
  name: string;
  success: boolean;
  /** 本次检测到的已删除渠道数 */
  orphans: number;
  /** 新发现的（之前没记录过） */
  created: number;
  /** 更新了消费量的 */
  updated: number;
  /** 仍存活的渠道数，仅作参考 */
  aliveChannels: number;
  /** 已删除渠道的消费折合人民币 */
  orphanRevenueRmb: number;
  /** 其中你还没填成本的部分 */
  unresolvedRevenueRmb: number;
  scanned: number;
  total: number;
  complete: boolean;
  channelListLoaded: boolean;
  error?: string;
}

/**
 * 扫描一个下游站点，找出已删除渠道的消费。
 *
 * 注意：只扫指定区间。区间外的旧消费不会动，已有记录也不会被清掉 ——
 * 你填过的成本要保住。
 */
export async function detectOrphanChannels(
  siteId: string,
  opts: {
    startDay: string;
    endDay: string;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<OrphanDetectResult> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  const base: OrphanDetectResult = {
    id: siteId,
    name: site?.name ?? "?",
    success: false,
    orphans: 0,
    created: 0,
    updated: 0,
    aliveChannels: 0,
    orphanRevenueRmb: 0,
    unresolvedRevenueRmb: 0,
    scanned: 0,
    total: 0,
    complete: false,
    channelListLoaded: false,
  };
  if (!site) return { ...base, error: "下游站点不存在" };

  const startDay = assertDay(opts.startDay, "startDay");
  const endDay = assertDay(opts.endDay, "endDay");
  if (endDay < startDay) return { ...base, error: "结束日期不能早于开始日期" };

  const quotaPerUnit = site.quotaPerDollar || DEFAULT_QUOTA_PER_UNIT;
  const usage = await fetchDownstreamChannelUsage({
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId ?? 1,
    quotaPerDollar: quotaPerUnit,
    startDay,
    endDay,
    pageSize: opts.pageSize,
    maxPages: opts.maxPages,
  });

  if (!usage.success) {
    return { ...base, error: usage.error, channelListLoaded: usage.channelListLoaded };
  }

  const dead = usage.channels.filter((c) => !c.alive && c.quota > 0);
  const alive = usage.channels.length - dead.length;

  let created = 0;
  let updated = 0;
  let orphanRevenueRmb = 0;
  let unresolvedRevenueRmb = 0;

  for (const c of dead) {
    const revenueRmb = c.quota / quotaPerUnit;
    orphanRevenueRmb += revenueRmb;

    const existing = await prisma.downstreamOrphanChannel.findUnique({
      where: {
        downstreamId_channelId: { downstreamId: siteId, channelId: c.channelId },
      },
    });

    // 只更新事实字段（消费量/区间/模型），你填的成本与标记一律不碰
    const facts = {
      channelName: c.channelName,
      models: c.models.join(",") || null,
      quota: c.quota,
      revenueRmb,
      quotaPerUnit,
      requests: c.requests,
      firstDay:
        existing && existing.firstDay < c.firstDay ? existing.firstDay : c.firstDay,
      lastDay: existing && existing.lastDay > c.lastDay ? existing.lastDay : c.lastDay,
    };

    if (existing) {
      await prisma.downstreamOrphanChannel.update({
        where: { id: existing.id },
        data: facts,
      });
      updated++;
      if (!existing.ignored && !existing.resolved) unresolvedRevenueRmb += revenueRmb;
    } else {
      await prisma.downstreamOrphanChannel.create({
        data: {
          downstreamId: siteId,
          channelId: c.channelId,
          ...facts,
        },
      });
      created++;
      unresolvedRevenueRmb += revenueRmb;
    }
  }

  const notes: string[] = [];
  if (!usage.complete) {
    notes.push(
      `日志未扫完（已扫 ${usage.scanned}/${usage.total} 条），旧渠道消费可能偏低`,
    );
  }
  if (!usage.channelListLoaded) {
    notes.push("读不到渠道列表，仅按日志渠道名为空判定删除，可能有误判");
  }
  if (notes.length) {
    await prisma.downstreamSite.update({
      where: { id: siteId },
      data: { lastError: notes.join("；").slice(0, 300) },
    });
  }

  return {
    id: siteId,
    name: site.name,
    success: true,
    orphans: dead.length,
    created,
    updated,
    aliveChannels: alive,
    orphanRevenueRmb: round2(orphanRevenueRmb),
    unresolvedRevenueRmb: round2(unresolvedRevenueRmb),
    scanned: usage.scanned,
    total: usage.total,
    complete: usage.complete,
    channelListLoaded: usage.channelListLoaded,
  };
}

/** 列出某站点（或全部）的旧渠道记录，附带当前应计成本 */
export async function listOrphanChannels(siteId?: string) {
  const rows = await prisma.downstreamOrphanChannel.findMany({
    where: siteId ? { downstreamId: siteId } : {},
    orderBy: [{ resolved: "asc" }, { revenueRmb: "desc" }],
    include: { downstream: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    downstreamId: r.downstreamId,
    downstreamName: r.downstream.name,
    channelId: r.channelId,
    channelName: r.channelName,
    models: r.models ? r.models.split(",").filter(Boolean) : [],
    quota: r.quota,
    revenueRmb: round2(r.revenueRmb),
    quotaPerUnit: r.quotaPerUnit,
    requests: r.requests,
    firstDay: r.firstDay,
    lastDay: r.lastDay,
    costMode: r.costMode,
    costRate: r.costRate,
    costAmountRmb: r.costAmountRmb,
    /** 按当前填法算出的成本 */
    costRmb: orphanCostRmb(r),
    resolved: r.resolved,
    ignored: r.ignored,
    note: r.note,
    detectedAt: r.detectedAt,
    /** 毛利 = 卖出 − 成本，便于你判断填的成本是否合理 */
    marginRmb: round2(r.revenueRmb - orphanCostRmb(r)),
  }));
}

/**
 * 按周期算旧渠道应计成本。
 *
 * 记录跨越多天时按重叠天数比例摊到当前周期 —— 跟成本台账一个思路，
 * 避免一笔跨月的旧渠道成本在每个月都整笔计一次。
 */
export async function orphanCostForPeriod(
  startDay: string,
  endDay: string,
): Promise<{
  totalRmb: number;
  unresolvedRevenueRmb: number;
  unresolvedCount: number;
  entries: {
    id: string;
    downstreamName: string;
    channelId: number;
    channelName: string;
    revenueRmb: number;
    costRmb: number;
    allocatedRmb: number;
    /** 这笔消费的实际存续区间，画逐日图时用来均摊 */
    firstDay: string;
    lastDay: string;
    overlapDays: number;
    effectiveDays: number;
    resolved: boolean;
    ignored: boolean;
  }[];
}> {
  const rows = await prisma.downstreamOrphanChannel.findMany({
    where: { firstDay: { lte: endDay }, lastDay: { gte: startDay } },
    include: { downstream: { select: { name: true } } },
  });

  let totalRmb = 0;
  let unresolvedRevenueRmb = 0;
  let unresolvedCount = 0;
  const entries: Awaited<ReturnType<typeof orphanCostForPeriod>>["entries"] = [];

  for (const r of rows) {
    const effectiveDays = inclusiveDays(r.firstDay, r.lastDay) || 1;
    const covered = overlapDays(r.firstDay, r.lastDay, startDay, endDay);
    if (covered <= 0) continue;

    const costRmb = orphanCostRmb(r);
    const allocatedRmb = round2((costRmb * covered) / effectiveDays);
    totalRmb += allocatedRmb;

    if (!r.ignored && !r.resolved) {
      unresolvedCount++;
      unresolvedRevenueRmb += round2((r.revenueRmb * covered) / effectiveDays);
    }

    entries.push({
      id: r.id,
      downstreamName: r.downstream.name,
      channelId: r.channelId,
      channelName: r.channelName,
      revenueRmb: round2(r.revenueRmb),
      costRmb,
      allocatedRmb,
      firstDay: r.firstDay,
      lastDay: r.lastDay,
      overlapDays: covered,
      effectiveDays,
      resolved: r.resolved,
      ignored: r.ignored,
    });
  }

  entries.sort((a, b) => b.allocatedRmb - a.allocatedRmb);
  return {
    totalRmb: round2(totalRmb),
    unresolvedRevenueRmb: round2(unresolvedRevenueRmb),
    unresolvedCount,
    entries,
  };
}
