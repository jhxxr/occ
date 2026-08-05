/**
 * 周期收益报表
 *
 *   收入     = Σ 下游 NewAPI 日志里付费账号真实扣掉的额度 → 人民币
 *   上游成本 = Σ 勾选「计入中转」Key 的当日实际扣费 × 当日购入成本率
 *   额外成本 = 成本台账（自建号采购 / 订阅）+ 旧渠道补录
 *
 *   服务毛利 = 收入 − 上游成本 − 额外成本
 *
 * 每一项都取「当时落库的事实」：成本率写入当日冻结，消费按日快照。
 * 改今天的配置不会改写历史周期。
 *
 * 曾经有个「倍率法」（官方基准用量 × 下游卖出倍率）想跟实测法互校，已删除：
 * 倍率只存当前值、没有生效时间，改一次倍率就会把所有历史报表重算一遍 ——
 * 会改写历史的估算比没有估算更糟。
 *
 * 不计入收入的东西：客户充值（负债/现金流）、下游已发放余额（存量）、
 * 测试账号消费（没人付钱，只烧了上游成本）。
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
import { orphanCostForPeriod } from "@/lib/orphan-channels";

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return round2((part / whole) * 100);
}

/** 警告文案里用的人民币格式 */
function formatCny(n: number): string {
  return `¥${n.toFixed(2)}`;
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
  upstreamCostRmb: number;
  operatingCostRmb: number;
  profitMeasuredRmb: number;
}

export interface SiteRow {
  id: string;
  name: string;
  enabled: boolean;
  /** 付费账号消费 —— 收入 */
  revenueRmb: number;
  /** 其中私域（自己推广的用户） */
  privateRmb: number;
  /** 其中公共池（其余渠道，含朋友推广的） */
  publicRmb: number;
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
  /** 私域是否真的拆出来了 */
  privateResolved: boolean;
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
  /** 上游分组倍率，仅作展示（当前值，不参与任何计算） */
  upstreamRate: number | null;
  /** 官方计价面值，来自明细里当日冻结的 standardCost */
  officialBase: number;
  /** 实际扣费面值 */
  actualCost: number;
  /** 折算成本 */
  costRmb: number;
  requests: number;
}

export interface FinancialReport {
  period: ReportingPeriod;
  generatedAt: string;
  usdCny: number;
  revenue: {
    measuredRmb: number;
    /** 其中私域（自己推广的用户） */
    privateRmb: number;
    /** 其中公共池（其余渠道，含朋友推广的） */
    publicRmb: number;
    /** 全部账号消费（含测试号），跟上游成本对差值用，**不是收入** */
    grossConsumptionRmb: number;
    /** 测试号烧掉的额度，已从收入里剔除 */
    excludedRmb: number;
  };
  cost: {
    upstreamRmb: number;
    operatingRmb: number;
    /** 已删除渠道的补录成本（你手工填的） */
    orphanRmb: number;
    totalRmb: number;
    source: "usage-logs" | "snapshots" | "mixed" | "none";
  };
  profit: {
    measuredRmb: number;
    measuredMarginPct: number | null;
    /**
     * 私域 / 公共各自的毛利。
     *
     * 成本按收入占比分摊 —— 上游成本记在 Key 上，拿不到「这笔消费是谁烧的」，
     * 只能按比例摊。所以这两个数是**估算口径**，别拿去做精确结算；
     * 总毛利（measuredRmb）仍是实测事实。
     */
    privateRmb: number;
    publicRmb: number;
    privateMarginPct: number | null;
    publicMarginPct: number | null;
    /** 分摊依据：私域收入占总收入的比例 */
    privateShare: number;
  };
  daily: DailyPoint[];
  bySite: SiteRow[];
  byProvider: ProviderRow[];
  byKey: KeyRow[];
  operatingCosts: CostAllocation[];
  /** 已删除渠道：消费还在但上游成本没了，需要你补录 */
  orphanChannels: {
    id: string;
    downstreamName: string;
    channelId: number;
    channelName: string;
    /** 该周期内的消费（从逐日缓存精确取） */
    revenueRmb: number;
    allocatedRmb: number;
    resolved: boolean;
    ignored: boolean;
  }[];
  reference: {
    /** 自建站官方计价用量，仅参考，不计入毛利 */
    selfHostedOfficialCost: number;
    /** 下游当前已发放额度（存量，不是收益） */
    downstreamIssuedRmb: number;
    /** 本周期上游充值实付（现金流，不是成本） */
    upstreamRechargePaidRmb: number;
  };
  coverage: {
    measuredComplete: boolean;
    costComplete: boolean;
    billableKeys: number;
    sitesMissingDays: number;
    /** 拿不到逐账号消费、测试号还混在收入里的站点数 */
    sitesUnresolvedExclude: number;
    /** 拿不到逐账号消费、私域未拆分的站点数 */
    sitesUnresolvedPrivate: number;
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
  const privateByDay = new Map<string, number>();
  const siteAgg = new Map<
    string,
    {
      revenueRmb: number;
      privateRmb: number;
      grossRmb: number;
      excludedRmb: number;
      quota: number;
      requests: number;
      days: Set<string>;
      incomplete: number;
      unresolved: number;
      unresolvedPrivate: number;
    }
  >();

  for (const row of totalRows) {
    revenueByDay.set(row.day, (revenueByDay.get(row.day) || 0) + (row.revenueRmb || 0));
    grossByDay.set(
      row.day,
      (grossByDay.get(row.day) || 0) + (row.grossRevenueRmb || row.revenueRmb || 0),
    );
    privateByDay.set(
      row.day,
      (privateByDay.get(row.day) || 0) + (row.privateRevenueRmb || 0),
    );
    const cur =
      siteAgg.get(row.downstreamId) ||
      {
        revenueRmb: 0,
        privateRmb: 0,
        grossRmb: 0,
        excludedRmb: 0,
        quota: 0,
        requests: 0,
        days: new Set<string>(),
        incomplete: 0,
        unresolved: 0,
        unresolvedPrivate: 0,
      };
    const gross = row.grossRevenueRmb || row.revenueRmb || 0;
    cur.revenueRmb += row.revenueRmb || 0;
    cur.privateRmb += row.privateRevenueRmb || 0;
    cur.grossRmb += gross;
    cur.excludedRmb += gross - (row.revenueRmb || 0);
    cur.quota += row.quota || 0;
    cur.requests += row.requests || 0;
    cur.days.add(row.day);
    if (!row.complete) cur.incomplete++;
    if (!row.excludeResolved) cur.unresolved++;
    if (!row.privateResolved) cur.unresolvedPrivate++;
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
  /** 私域收入；公共池用减法现算，避免两个数各自漂移 */
  const privateRevenueRmb = round2(
    [...privateByDay.values()].reduce((s, v) => s + v, 0),
  );
  const publicRevenueRmb = round2(measuredRevenueRmb - privateRevenueRmb);

  const expectedDays = elapsedDays(period, today);
  const enabledSites = sites.filter((s) => s.enabled);
  let sitesMissingDays = 0;
  let sitesUnresolvedExclude = 0;
  let sitesUnresolvedPrivate = 0;
  const bySite: SiteRow[] = sites.map((s) => {
    const agg = siteAgg.get(s.id);
    const covered = agg?.days.size ?? 0;
    const missing = s.enabled ? Math.max(0, expectedDays - covered) : 0;
    if (missing > 0) sitesMissingDays += missing;
    if ((agg?.unresolved ?? 0) > 0) sitesUnresolvedExclude++;
    if ((agg?.unresolvedPrivate ?? 0) > 0) sitesUnresolvedPrivate++;
    const siteRevenue = round2(agg?.revenueRmb ?? 0);
    const sitePrivate = round2(agg?.privateRmb ?? 0);
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      revenueRmb: siteRevenue,
      privateRmb: sitePrivate,
      publicRmb: round2(siteRevenue - sitePrivate),
      grossRmb: round2(agg?.grossRmb ?? 0),
      excludedRmb: round2(agg?.excludedRmb ?? 0),
      quota: Math.round(agg?.quota ?? 0),
      requests: agg?.requests ?? 0,
      missingDays: missing,
      incompleteDays: agg?.incomplete ?? 0,
      excludeResolved: (agg?.unresolved ?? 0) === 0,
      privateResolved: (agg?.unresolvedPrivate ?? 0) === 0,
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
  if (sitesUnresolvedPrivate > 0) {
    warnings.push(
      `有 ${sitesUnresolvedPrivate} 个站点拿不到逐账号消费，私域收入未拆分（全部计入公共池）`,
    );
  }

  // ——— 按 Key 的成本明细（纯事实，不做任何倍率推算）———
  const usageByKey = new Map<
    string,
    { actualCost: number; standardCost: number; costRmb: number; requests: number }
  >();
  for (const row of billableUsage) {
    const id = `${row.providerId}|${row.remoteKeyId}`;
    const cur =
      usageByKey.get(id) ||
      { actualCost: 0, standardCost: 0, costRmb: 0, requests: 0 };
    cur.actualCost += row.actualCost || 0;
    cur.standardCost += row.standardCost || 0;
    cur.costRmb += row.costRmb || 0;
    cur.requests += row.requests || 0;
    usageByKey.set(id, cur);
  }

  const byKey: KeyRow[] = [];
  for (const key of keys) {
    if (!key.countAsCost) continue;
    if (!relayIds.has(key.providerId)) continue;
    const usage = usageByKey.get(`${key.providerId}|${key.remoteKeyId}`);

    byKey.push({
      providerId: key.providerId,
      providerName: providerNameById.get(key.providerId) || "?",
      remoteKeyId: key.remoteKeyId,
      keyName: key.name || key.keyPreview || key.remoteKeyId,
      upstreamRate: key.rateMultiplier ?? null,
      officialBase: round2(usage?.standardCost ?? 0),
      actualCost: round2(usage?.actualCost ?? 0),
      costRmb: round2(usage?.costRmb ?? 0),
      requests: usage?.requests ?? 0,
    });
  }

  byKey.sort((a, b) => b.costRmb - a.costRmb);

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
  // 旧渠道：渠道从 NewAPI 删掉后上游成本对不上了，用你补录的金额补进成本。
  // 消费量按天从缓存精确取，不用按天数比例去猜。
  const orphan = await orphanCostForPeriod(period.startDay, period.endDay);

  const daily: DailyPoint[] = dayList.map((day) => {
    const revenueMeasured = round2(revenueByDay.get(day) || 0);
    const grossConsumption = round2(grossByDay.get(day) || 0);
    const upstream = round2(costByDay.get(day) || 0);
    const operating = round2(
      (costSummary.byDay.get(day) || 0) + (orphan.byDay.get(day) || 0),
    );
    return {
      day,
      revenueMeasuredRmb: revenueMeasured,
      grossConsumptionRmb: grossConsumption,
      upstreamCostRmb: upstream,
      operatingCostRmb: operating,
      profitMeasuredRmb: round2(revenueMeasured - upstream - operating),
    };
  });

  // ——— 汇总 ———
  const operatingRmb = costSummary.totalRmb;
  const totalCostRmb = round2(upstreamCostRmb + operatingRmb + orphan.totalRmb);

  if (orphan.unresolvedCount > 0) {
    warnings.push(
      `有 ${orphan.unresolvedCount} 个已删除渠道产生了 ${formatCny(orphan.unresolvedRevenueRmb)} 消费但没填成本，毛利偏高`,
    );
  }
  if (orphan.estimatedMonths > 0) {
    warnings.push(
      `本周期有 ${orphan.estimatedMonths} 个月的旧渠道缓存已压缩成月汇总，成本按天数比例摊算（估算）`,
    );
  }

  const measuredProfit = round2(measuredRevenueRmb - totalCostRmb);

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

  // 私域 / 公共各自的毛利：成本按收入占比分摊。
  // 上游成本记在 Key 上，追不到「这笔消费是谁烧的」，只能按比例摊 ——
  // 所以这是估算，总毛利仍以 measuredProfit 为准。
  const privateShare =
    measuredRevenueRmb > 0 ? privateRevenueRmb / measuredRevenueRmb : 0;
  const privateProfit = round2(
    privateRevenueRmb - totalCostRmb * privateShare,
  );
  const publicProfit = round2(measuredProfit - privateProfit);

  return {
    period,
    generatedAt: new Date().toISOString(),
    usdCny,
    revenue: {
      measuredRmb: measuredRevenueRmb,
      privateRmb: privateRevenueRmb,
      publicRmb: publicRevenueRmb,
      grossConsumptionRmb,
      excludedRmb: excludedRevenueRmb,
    },
    cost: {
      upstreamRmb: upstreamCostRmb,
      operatingRmb,
      orphanRmb: orphan.totalRmb,
      totalRmb: totalCostRmb,
      source: costSource,
    },
    profit: {
      measuredRmb: measuredProfit,
      measuredMarginPct:
        measuredRevenueRmb > 0 ? pct(measuredProfit, measuredRevenueRmb) : null,
      privateRmb: privateProfit,
      publicRmb: publicProfit,
      privateMarginPct:
        privateRevenueRmb > 0 ? pct(privateProfit, privateRevenueRmb) : null,
      publicMarginPct:
        publicRevenueRmb > 0 ? pct(publicProfit, publicRevenueRmb) : null,
      privateShare: round2(privateShare * 100) / 100,
    },
    daily,
    bySite,
    byProvider,
    byKey,
    operatingCosts: costSummary.entries,
    orphanChannels: orphan.entries,
    reference: {
      selfHostedOfficialCost,
      downstreamIssuedRmb,
      upstreamRechargePaidRmb: round2(
        recharges.reduce((s, r) => s + (r.paidRmb || 0), 0),
      ),
    },
    coverage: {
      measuredComplete,
      costComplete,
      billableKeys,
      sitesMissingDays,
      sitesUnresolvedExclude,
      sitesUnresolvedPrivate,
      snapshotEstimatedProviderDays,
      earlyEndedCostEntries: costSummary.earlyEndedCount,
      openEndedCostEntries: costSummary.openEndedCount,
      warnings,
    },
  };
}
