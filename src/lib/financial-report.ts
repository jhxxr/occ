/**
 * 周期收益报表：双口径互校
 *
 * 收入两条算法同时跑，互为校验（上下游计费细节不完全一致，单条都做不到绝对精准）：
 *
 *   A 实测法：Σ 下游 NewAPI 日志里真实扣掉的额度 → 人民币
 *   B 倍率法：Σ 上游计费 Key 的官方基准用量 × 该批流量在下游卖出的分组倍率
 *
 * 成本两法共用：
 *   上游成本 = Σ 勾选「计入中转」Key 的当日实际扣费 × 当日购入成本率
 *   额外成本 = 成本台账（自建号采购 / 订阅，按记账日或按有效期摊销）
 *
 *   服务毛利 = 收入 − 上游成本 − 额外成本
 *
 * 不计入收入的东西：客户充值（负债/现金流）、下游已发放余额（存量）、
 * 自建站「官方用量 × 卖出倍率」（那是同一批流量的中间层估算，会重复确认）。
 */

import { prisma } from "@/lib/db";
import { relayOnly, selfHostedOnly } from "@/lib/provider-kinds";
import { getUsdCnyRate } from "@/lib/sync";
import {
  addDays,
  elapsedDays,
  enumerateDays,
  shanghaiDay,
  type ReportingPeriod,
} from "@/lib/reporting-period";
import {
  summarizeCosts,
  type CostAllocation,
  type CostEntryInput,
} from "@/lib/operating-cost";

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return round2((part / whole) * 100);
}

/** 闭区间日期 → 北京时间的真实时间戳区间 [start, end) */
function periodToInstants(period: ReportingPeriod): { start: Date; end: Date } {
  return {
    start: new Date(`${period.startDay}T00:00:00+08:00`),
    end: new Date(`${addDays(period.endDay, 1)}T00:00:00+08:00`),
  };
}

export interface DailyPoint {
  day: string;
  revenueMeasuredRmb: number;
  /** 含测试号的全站消费，对账用 */
  grossConsumptionRmb: number;
  revenueRatioRmb: number;
  upstreamCostRmb: number;
  operatingCostRmb: number;
  profitMeasuredRmb: number;
  profitRatioRmb: number;
}

export interface SiteRow {
  id: string;
  name: string;
  enabled: boolean;
  /** 付费账号消费 —— 收入 */
  revenueRmb: number;
  /** 全部账号消费（含测试号）—— 对账用 */
  grossRmb: number;
  /** 测试号烧掉的部分 */
  excludedRmb: number;
  quota: number;
  requests: number;
  /** 该站点在本周期缺失日报的天数 */
  missingDays: number;
  incompleteDays: number;
  /** 测试号是否真的从收入里剔掉了 */
  excludeResolved: boolean;
  lastSyncAt: Date | null;
}

export interface ProviderRow {
  id: string;
  name: string;
  type: string;
  costRmb: number;
  actualCost: number;
  standardCost: number;
  requests: number;
  /** usage-logs = Key 级精确；snapshots = 快照估算 */
  source: "usage-logs" | "snapshots" | "mixed" | "none";
}

export interface KeyRow {
  providerId: string;
  providerName: string;
  remoteKeyId: string;
  keyName: string;
  /** 上游分组倍率 */
  upstreamRate: number | null;
  /** 下游卖出倍率 */
  downstreamRate: number | null;
  downstreamSiteName: string | null;
  downstreamGroup: string | null;
  rateSource: "key" | "group" | "site-default" | "none";
  /** 官方基准用量（未乘任何倍率的面值） */
  officialBase: number;
  actualCost: number;
  costRmb: number;
  /** 倍率法估算卖出收入 */
  estimatedRevenueRmb: number | null;
  estimatedProfitRmb: number | null;
  marginPct: number | null;
}

export interface FinancialReport {
  period: ReportingPeriod;
  generatedAt: string;
  usdCny: number;
  revenue: {
    measuredRmb: number;
    ratioRmb: number | null;
    /** 两法差额（倍率法 − 实测法） */
    diffRmb: number | null;
    diffPct: number | null;
    /** 两法中位值，都可用时给一个折中数 */
    midpointRmb: number | null;
    /** 全部账号消费（含测试号），跟上游成本对差值用，**不是收入** */
    grossConsumptionRmb: number;
    /** 测试号烧掉的额度，已从收入里剔除 */
    excludedRmb: number;
  };
  cost: {
    upstreamRmb: number;
    operatingRmb: number;
    totalRmb: number;
    source: "usage-logs" | "snapshots" | "mixed" | "none";
  };
  profit: {
    measuredRmb: number;
    ratioRmb: number | null;
    measuredMarginPct: number | null;
    ratioMarginPct: number | null;
    /** 两法毛利差额，越小说明估算越可信 */
    spreadRmb: number | null;
  };
  daily: DailyPoint[];
  bySite: SiteRow[];
  byProvider: ProviderRow[];
  byKey: KeyRow[];
  operatingCosts: CostAllocation[];
  reference: {
    /** 自建站官方用量 × 卖出倍率，仅参考，已排除在毛利之外 */
    selfHostedSellRmb: number;
    selfHostedOfficialCost: number;
    /** 下游当前已发放额度（存量，不是收益） */
    downstreamIssuedRmb: number;
    /** 本周期上游充值实付（现金流，不是成本） */
    upstreamRechargePaidRmb: number;
  };
  coverage: {
    measuredComplete: boolean;
    ratioComplete: boolean;
    costComplete: boolean;
    /** 有成本但没绑定下游倍率的 Key 数 */
    unmappedKeys: number;
    unmappedCostRmb: number;
    billableKeys: number;
    sitesMissingDays: number;
    /** 拿不到逐账号消费、测试号还混在收入里的站点数 */
    sitesUnresolvedExclude: number;
    snapshotEstimatedProviderDays: number;
    earlyEndedCostEntries: number;
    openEndedCostEntries: number;
    warnings: string[];
  };
}

export async function buildFinancialReport(
  period: ReportingPeriod,
): Promise<FinancialReport> {
  const today = shanghaiDay();
  const { start: periodStart, end: periodEnd } = periodToInstants(period);
  const dayList = enumerateDays(period.startDay, period.endDay);

  const [
    usdCny,
    relayProviders,
    selfHostedProviders,
    sites,
    usageDailies,
    snapshots,
    keys,
    groupRates,
    costEntries,
    downstreamDaily,
    selfHostedDaily,
    recharges,
  ] = await Promise.all([
    getUsdCnyRate(),
    prisma.upstreamProvider.findMany({ where: relayOnly, orderBy: { createdAt: "asc" } }),
    prisma.upstreamProvider.findMany({ where: selfHostedOnly, orderBy: { createdAt: "asc" } }),
    prisma.downstreamSite.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.upstreamUsageDaily.findMany({
      where: { day: { gte: period.startDay, lte: period.endDay } },
      orderBy: { day: "asc" },
    }),
    prisma.snapshotLog.findMany({
      where: { timestamp: { gte: periodStart, lt: periodEnd } },
      orderBy: { timestamp: "asc" },
    }),
    prisma.upstreamApiKey.findMany({}),
    prisma.downstreamGroupRate.findMany({}),
    prisma.operatingCostEntry.findMany({ where: { status: { not: "void" } } }),
    prisma.downstreamUsageDaily.findMany({
      where: { day: { gte: period.startDay, lte: period.endDay } },
      orderBy: { day: "asc" },
    }),
    prisma.selfHostedGroupDaily.findMany({
      where: { track: true, day: { gte: period.startDay, lte: period.endDay } },
    }),
    prisma.upstreamRechargeLog.findMany({
      where: { status: "confirmed", rechargedAt: { gte: periodStart, lt: periodEnd } },
    }),
  ]);

  const relayIds = new Set(relayProviders.map((p) => p.id));
  const providerNameById = new Map(
    [...relayProviders, ...selfHostedProviders].map((p) => [p.id, p.name]),
  );
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const warnings: string[] = [];

  // ——— 上游成本：Key 级日聚合优先，缺日再用快照估算 ———
  const billableUsage = usageDailies.filter(
    (d) => relayIds.has(d.providerId) && d.countAsCost,
  );
  /** 有精确用量的 provider-day，禁止再叠加快照 */
  const preciseProviderDays = new Set(
    usageDailies
      .filter((d) => relayIds.has(d.providerId))
      .map((d) => `${d.providerId}|${d.day}`),
  );

  const costByDay = new Map<string, number>();
  const costByProvider = new Map<
    string,
    { costRmb: number; actualCost: number; standardCost: number; requests: number; precise: boolean; estimated: boolean }
  >();

  function bumpProvider(
    providerId: string,
    patch: Partial<{ costRmb: number; actualCost: number; standardCost: number; requests: number }>,
    kind: "precise" | "estimated",
  ) {
    const cur =
      costByProvider.get(providerId) ||
      { costRmb: 0, actualCost: 0, standardCost: 0, requests: 0, precise: false, estimated: false };
    cur.costRmb += patch.costRmb || 0;
    cur.actualCost += patch.actualCost || 0;
    cur.standardCost += patch.standardCost || 0;
    cur.requests += patch.requests || 0;
    if (kind === "precise") cur.precise = true;
    else cur.estimated = true;
    costByProvider.set(providerId, cur);
  }

  for (const row of billableUsage) {
    costByDay.set(row.day, (costByDay.get(row.day) || 0) + (row.costRmb || 0));
    bumpProvider(
      row.providerId,
      {
        costRmb: row.costRmb || 0,
        actualCost: row.actualCost || 0,
        standardCost: row.standardCost || 0,
        requests: row.requests || 0,
      },
      "precise",
    );
  }

  let snapshotEstimatedProviderDays = 0;
  const snapshotDaysSeen = new Set<string>();
  for (const snap of snapshots) {
    if (!relayIds.has(snap.upstreamId)) continue;
    const day = shanghaiDay(snap.timestamp);
    const pdKey = `${snap.upstreamId}|${day}`;
    if (preciseProviderDays.has(pdKey)) continue;
    if (!(snap.costRmb > 0)) continue;
    costByDay.set(day, (costByDay.get(day) || 0) + snap.costRmb);
    bumpProvider(
      snap.upstreamId,
      { costRmb: snap.costRmb, actualCost: snap.deltaConsumed || 0 },
      "estimated",
    );
    if (!snapshotDaysSeen.has(pdKey)) {
      snapshotDaysSeen.add(pdKey);
      snapshotEstimatedProviderDays++;
    }
  }

  const upstreamCostRmb = round2(
    [...costByDay.values()].reduce((s, v) => s + v, 0),
  );

  const anyPrecise = [...costByProvider.values()].some((v) => v.precise);
  const anyEstimated = [...costByProvider.values()].some((v) => v.estimated);
  const costSource: FinancialReport["cost"]["source"] =
    anyPrecise && anyEstimated
      ? "mixed"
      : anyPrecise
        ? "usage-logs"
        : anyEstimated
          ? "snapshots"
          : "none";

  // ——— A 实测法收入：下游日志真实扣费 ———
  const totalRows = downstreamDaily.filter((r) => r.scope === "TOTAL");
  const revenueByDay = new Map<string, number>();
  const grossByDay = new Map<string, number>();
  const siteAgg = new Map<
    string,
    {
      revenueRmb: number;
      grossRmb: number;
      excludedRmb: number;
      quota: number;
      requests: number;
      days: Set<string>;
      incomplete: number;
      unresolved: number;
    }
  >();

  for (const row of totalRows) {
    revenueByDay.set(row.day, (revenueByDay.get(row.day) || 0) + (row.revenueRmb || 0));
    grossByDay.set(
      row.day,
      (grossByDay.get(row.day) || 0) + (row.grossRevenueRmb || row.revenueRmb || 0),
    );
    const cur =
      siteAgg.get(row.downstreamId) ||
      {
        revenueRmb: 0,
        grossRmb: 0,
        excludedRmb: 0,
        quota: 0,
        requests: 0,
        days: new Set<string>(),
        incomplete: 0,
        unresolved: 0,
      };
    const gross = row.grossRevenueRmb || row.revenueRmb || 0;
    cur.revenueRmb += row.revenueRmb || 0;
    cur.grossRmb += gross;
    cur.excludedRmb += gross - (row.revenueRmb || 0);
    cur.quota += row.quota || 0;
    cur.requests += row.requests || 0;
    cur.days.add(row.day);
    if (!row.complete) cur.incomplete++;
    if (!row.excludeResolved) cur.unresolved++;
    siteAgg.set(row.downstreamId, cur);
  }

  const measuredRevenueRmb = round2(
    [...revenueByDay.values()].reduce((s, v) => s + v, 0),
  );
  /** 全部账号消费（含测试号）—— 跟上游成本对差值用，不是收入 */
  const grossConsumptionRmb = round2(
    [...grossByDay.values()].reduce((s, v) => s + v, 0),
  );
  const excludedRevenueRmb = round2(grossConsumptionRmb - measuredRevenueRmb);

  const expectedDays = elapsedDays(period, today);
  const enabledSites = sites.filter((s) => s.enabled);
  let sitesMissingDays = 0;
  let sitesUnresolvedExclude = 0;
  const bySite: SiteRow[] = sites.map((s) => {
    const agg = siteAgg.get(s.id);
    const covered = agg?.days.size ?? 0;
    const missing = s.enabled ? Math.max(0, expectedDays - covered) : 0;
    if (missing > 0) sitesMissingDays += missing;
    if ((agg?.unresolved ?? 0) > 0) sitesUnresolvedExclude++;
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      revenueRmb: round2(agg?.revenueRmb ?? 0),
      grossRmb: round2(agg?.grossRmb ?? 0),
      excludedRmb: round2(agg?.excludedRmb ?? 0),
      quota: Math.round(agg?.quota ?? 0),
      requests: agg?.requests ?? 0,
      missingDays: missing,
      incompleteDays: agg?.incomplete ?? 0,
      excludeResolved: (agg?.unresolved ?? 0) === 0,
      lastSyncAt: s.lastSyncAt,
    };
  });

  const measuredComplete =
    enabledSites.length > 0 && sitesMissingDays === 0 &&
    bySite.every((s) => s.incompleteDays === 0);

  if (enabledSites.length === 0) {
    warnings.push("尚未启用任何下游站点，实测法收入为 0");
  } else if (sitesMissingDays > 0) {
    warnings.push(
      `实测法缺 ${sitesMissingDays} 个站点日的消费数据，请先同步下游（收入会偏低）`,
    );
  }
  if (sitesUnresolvedExclude > 0) {
    warnings.push(
      `有 ${sitesUnresolvedExclude} 个站点拿不到逐账号消费，测试号还留在收入里（收入偏高）`,
    );
  }

  // ——— B 倍率法收入：官方基准用量 × 下游卖出倍率 ———
  const rateByKey = new Map<string, number>(
    groupRates
      .filter((g) => g.known && g.ratio > 0)
      .map((g) => [`${g.downstreamId}|${g.groupName}`, g.ratio]),
  );

  function resolveDownstreamRate(key: {
    downstreamSiteId: string | null;
    downstreamGroup: string | null;
    downstreamRate: number | null;
  }): { rate: number | null; source: KeyRow["rateSource"] } {
    if (key.downstreamRate != null && key.downstreamRate > 0) {
      return { rate: key.downstreamRate, source: "key" };
    }
    if (key.downstreamSiteId) {
      if (key.downstreamGroup) {
        const hit = rateByKey.get(`${key.downstreamSiteId}|${key.downstreamGroup}`);
        if (hit) return { rate: hit, source: "group" };
      }
      const fallback = rateByKey.get(`${key.downstreamSiteId}|default`);
      if (fallback) return { rate: fallback, source: "site-default" };
    }
    return { rate: null, source: "none" };
  }

  const usageByKey = new Map<
    string,
    { actualCost: number; standardCost: number; costRmb: number; requests: number; byDay: Map<string, { standardCost: number; actualCost: number }> }
  >();
  for (const row of billableUsage) {
    const id = `${row.providerId}|${row.remoteKeyId}`;
    const cur =
      usageByKey.get(id) ||
      { actualCost: 0, standardCost: 0, costRmb: 0, requests: 0, byDay: new Map() };
    cur.actualCost += row.actualCost || 0;
    cur.standardCost += row.standardCost || 0;
    cur.costRmb += row.costRmb || 0;
    cur.requests += row.requests || 0;
    const d = cur.byDay.get(row.day) || { standardCost: 0, actualCost: 0 };
    d.standardCost += row.standardCost || 0;
    d.actualCost += row.actualCost || 0;
    cur.byDay.set(row.day, d);
    usageByKey.set(id, cur);
  }

  const ratioRevenueByDay = new Map<string, number>();
  const byKey: KeyRow[] = [];
  let ratioRevenueRmb = 0;
  let unmappedKeys = 0;
  let unmappedCostRmb = 0;
  let mappedKeys = 0;

  for (const key of keys) {
    if (!key.countAsCost) continue;
    if (!relayIds.has(key.providerId)) continue;
    const usage = usageByKey.get(`${key.providerId}|${key.remoteKeyId}`);
    const actualCost = usage?.actualCost ?? 0;
    const costRmb = usage?.costRmb ?? 0;
    const upstreamRate = key.rateMultiplier ?? null;

    /** 官方基准用量：优先用明细里的官方计价，缺失时按上游倍率还原 */
    const officialBase = (() => {
      if (usage && usage.standardCost > 0) return usage.standardCost;
      if (upstreamRate && upstreamRate > 0) return actualCost / upstreamRate;
      return actualCost;
    })();

    const { rate, source } = resolveDownstreamRate(key);
    const estimatedRevenueRmb = rate != null ? round2(officialBase * rate) : null;

    if (rate == null) {
      if (costRmb > 0 || actualCost > 0) {
        unmappedKeys++;
        unmappedCostRmb += costRmb;
      }
    } else {
      mappedKeys++;
      ratioRevenueRmb += estimatedRevenueRmb ?? 0;
      if (usage) {
        for (const [day, d] of usage.byDay) {
          const base =
            d.standardCost > 0
              ? d.standardCost
              : upstreamRate && upstreamRate > 0
                ? d.actualCost / upstreamRate
                : d.actualCost;
          ratioRevenueByDay.set(day, (ratioRevenueByDay.get(day) || 0) + base * rate);
        }
      }
    }

    byKey.push({
      providerId: key.providerId,
      providerName: providerNameById.get(key.providerId) || "?",
      remoteKeyId: key.remoteKeyId,
      keyName: key.name || key.keyPreview || key.remoteKeyId,
      upstreamRate,
      downstreamRate: rate,
      downstreamSiteName: key.downstreamSiteId
        ? siteById.get(key.downstreamSiteId)?.name ?? null
        : null,
      downstreamGroup: key.downstreamGroup ?? null,
      rateSource: source,
      officialBase: round2(officialBase),
      actualCost: round2(actualCost),
      costRmb: round2(costRmb),
      estimatedRevenueRmb,
      estimatedProfitRmb:
        estimatedRevenueRmb != null ? round2(estimatedRevenueRmb - costRmb) : null,
      marginPct:
        estimatedRevenueRmb != null && estimatedRevenueRmb > 0
          ? pct(estimatedRevenueRmb - costRmb, estimatedRevenueRmb)
          : null,
    });
  }

  byKey.sort((a, b) => b.costRmb - a.costRmb);

  const ratioAvailable = mappedKeys > 0;
  const ratioComplete = ratioAvailable && unmappedKeys === 0;
  if (!ratioAvailable) {
    warnings.push(
      "倍率法不可用：请给「计入中转」的 Key 绑定下游站点/分组倍率",
    );
  } else if (unmappedKeys > 0) {
    warnings.push(
      `倍率法有 ${unmappedKeys} 个计费 Key 未绑定下游倍率（涉及成本 ¥${round2(unmappedCostRmb)}），估算收入偏低`,
    );
  }

  // ——— 额外成本台账 ———
  const costSummary = summarizeCosts(
    costEntries.map(
      (e): CostEntryInput => ({
        id: e.id,
        name: e.name,
        amountRmb: Number(e.amountRmb),
        mode: e.mode,
        startDay: e.startDay,
        plannedEndDay: e.plannedEndDay,
        actualEndDay: e.actualEndDay,
        status: e.status,
        category: e.category,
        providerId: e.providerId,
        accountId: e.accountId,
      }),
    ),
    period,
  );

  // ——— 逐日序列 ———
  const daily: DailyPoint[] = dayList.map((day) => {
    const revenueMeasured = round2(revenueByDay.get(day) || 0);
    const grossConsumption = round2(grossByDay.get(day) || 0);
    const revenueRatio = round2(ratioRevenueByDay.get(day) || 0);
    const upstream = round2(costByDay.get(day) || 0);
    const operating = round2(costSummary.byDay.get(day) || 0);
    return {
      day,
      revenueMeasuredRmb: revenueMeasured,
      grossConsumptionRmb: grossConsumption,
      revenueRatioRmb: revenueRatio,
      upstreamCostRmb: upstream,
      operatingCostRmb: operating,
      profitMeasuredRmb: round2(revenueMeasured - upstream - operating),
      profitRatioRmb: round2(revenueRatio - upstream - operating),
    };
  });

  // ——— 汇总 ———
  const operatingRmb = costSummary.totalRmb;
  const totalCostRmb = round2(upstreamCostRmb + operatingRmb);
  const ratioRevenue = ratioAvailable ? round2(ratioRevenueRmb) : null;

  const measuredProfit = round2(measuredRevenueRmb - totalCostRmb);
  const ratioProfit = ratioRevenue != null ? round2(ratioRevenue - totalCostRmb) : null;

  const byProvider: ProviderRow[] = relayProviders
    .map((p): ProviderRow => {
      const agg = costByProvider.get(p.id);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        costRmb: round2(agg?.costRmb ?? 0),
        actualCost: round2(agg?.actualCost ?? 0),
        standardCost: round2(agg?.standardCost ?? 0),
        requests: agg?.requests ?? 0,
        source: !agg
          ? "none"
          : agg.precise && agg.estimated
            ? "mixed"
            : agg.precise
              ? "usage-logs"
              : "snapshots",
      };
    })
    .sort((a, b) => b.costRmb - a.costRmb);

  const billableKeys = byKey.length;
  const costComplete = costSource === "usage-logs" && billableKeys > 0;
  if (billableKeys === 0) {
    warnings.push(
      "没有勾选「计入中转」的上游 Key，上游成本可能为 0 或只有快照估算",
    );
  } else if (snapshotEstimatedProviderDays > 0) {
    warnings.push(
      `有 ${snapshotEstimatedProviderDays} 个站点日只有快照估算成本，建议同步「使用记录库」`,
    );
  }

  const selfHostedSellRmb = round2(
    selfHostedDaily.reduce((s, d) => s + (d.sellRevenueRmb || 0), 0),
  );
  const selfHostedOfficialCost = round2(
    selfHostedDaily.reduce((s, d) => s + (d.officialCost || 0), 0),
  );
  const downstreamIssuedRmb = round2(
    sites.reduce((sum, site) => {
      const rev = site.lastRevenue ?? 0;
      if (!rev) return sum;
      return sum + (site.revenueCurrency === "USD" ? rev * usdCny : rev);
    }, 0),
  );

  return {
    period,
    generatedAt: new Date().toISOString(),
    usdCny,
    revenue: {
      measuredRmb: measuredRevenueRmb,
      ratioRmb: ratioRevenue,
      diffRmb: ratioRevenue != null ? round2(ratioRevenue - measuredRevenueRmb) : null,
      diffPct:
        ratioRevenue != null && measuredRevenueRmb > 0
          ? pct(ratioRevenue - measuredRevenueRmb, measuredRevenueRmb)
          : null,
      midpointRmb:
        ratioRevenue != null && measuredRevenueRmb > 0
          ? round2((ratioRevenue + measuredRevenueRmb) / 2)
          : null,
      grossConsumptionRmb,
      excludedRmb: excludedRevenueRmb,
    },
    cost: {
      upstreamRmb: upstreamCostRmb,
      operatingRmb,
      totalRmb: totalCostRmb,
      source: costSource,
    },
    profit: {
      measuredRmb: measuredProfit,
      ratioRmb: ratioProfit,
      measuredMarginPct:
        measuredRevenueRmb > 0 ? pct(measuredProfit, measuredRevenueRmb) : null,
      ratioMarginPct:
        ratioRevenue != null && ratioRevenue > 0 ? pct(ratioProfit ?? 0, ratioRevenue) : null,
      spreadRmb:
        ratioProfit != null ? round2(Math.abs(ratioProfit - measuredProfit)) : null,
    },
    daily,
    bySite,
    byProvider,
    byKey,
    operatingCosts: costSummary.entries,
    reference: {
      selfHostedSellRmb,
      selfHostedOfficialCost,
      downstreamIssuedRmb,
      upstreamRechargePaidRmb: round2(
        recharges.reduce((s, r) => s + (r.paidRmb || 0), 0),
      ),
    },
    coverage: {
      measuredComplete,
      ratioComplete,
      costComplete,
      unmappedKeys,
      unmappedCostRmb: round2(unmappedCostRmb),
      billableKeys,
      sitesMissingDays,
      sitesUnresolvedExclude,
      snapshotEstimatedProviderDays,
      earlyEndedCostEntries: costSummary.earlyEndedCount,
      openEndedCostEntries: costSummary.openEndedCount,
      warnings,
    },
  };
}
