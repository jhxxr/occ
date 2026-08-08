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
  monthPeriod,
  shanghaiDay,
  type ReportingPeriod,
} from "@/lib/reporting-period";
import {
  summarizeCosts,
  type CostAllocation,
  type CostEntryInput,
} from "@/lib/operating-cost";
import { orphanCostForPeriod } from "@/lib/orphan-channels";
import { allocateOwnershipCosts } from "@/lib/cost-allocation";
import { summarizePrepaid, type PrepaidTotals } from "@/lib/prepaid";

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

function parseUserIds(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(Number).filter((n) => Number.isFinite(n)));
  } catch {
    return new Set();
  }
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
     * 已有模型级上下游数据时，上游成本按模型精确对齐；没有匹配模型的
     * 成本以及额外成本，仍按收入占比分摊。总毛利始终是实测事实。
     */
    privateRmb: number;
    publicRmb: number;
    /** 分摊给私域、由私域收入承担的成本 */
    privateCostRmb: number;
    /** 分摊给公共池、运营方需要优先收回的成本 */
    publicCostRmb: number;
    privateMarginPct: number | null;
    publicMarginPct: number | null;
    /** 私域收入占总收入比例（仅用于分摊无法模型对齐的成本） */
    privateShare: number;
    /** model = 按模型对齐；revenue-share = 没有模型数据，退化成收入占比 */
    allocationSource: "model" | "revenue-share";
    /** 成功按模型分配的上游成本 */
    modelAllocatedCostRmb: number;
    /** 找不到同模型下游用量、只能回退按收入占比的上游成本 */
    fallbackCostRmb: number;
    /** 模型对齐覆盖上游成本的百分比 */
    modelCoveragePct: number;
  };
  prepaid: {
    /** 当前报表所选周期内实际到账的预收款 */
    period: PrepaidTotals;
    /** 当前自然月实际到账的预收款 */
    month: PrepaidTotals;
    /** 已同步到本地的全部历史预收款 */
    allTime: PrepaidTotals;
    complete: boolean;
    incompleteSites: number;
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
  const currentMonthPeriod = monthPeriod(today);
  const currentMonth = periodToInstants(currentMonthPeriod);
  const dayList = enumerateDays(period.startDay, period.endDay);

  const [
    usdCny,
    relayProviders,
    selfHostedProviders,
    sites,
    usageDailies,
    upstreamUsageLogs,
    snapshots,
    keys,
    costEntries,
    downstreamDaily,
    downstreamModelDaily,
    selfHostedDaily,
    recharges,
    downstreamTopups,
  ] = await Promise.all([
    getUsdCnyRate(),
    prisma.upstreamProvider.findMany({ where: relayOnly, orderBy: { createdAt: "asc" } }),
    prisma.upstreamProvider.findMany({ where: selfHostedOnly, orderBy: { createdAt: "asc" } }),
    prisma.downstreamSite.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.upstreamUsageDaily.findMany({
      where: { day: { gte: period.startDay, lte: period.endDay } },
      orderBy: { day: "asc" },
    }),
    prisma.upstreamUsageLog.findMany({
      where: {
        day: { gte: period.startDay, lte: period.endDay },
        model: { not: null },
      },
      select: {
        providerId: true,
        remoteKeyId: true,
        model: true,
        day: true,
        actualCost: true,
      },
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
    prisma.downstreamModelDaily.findMany({
      where: { day: { gte: period.startDay, lte: period.endDay } },
      orderBy: { day: "asc" },
    }),
    prisma.selfHostedGroupDaily.findMany({
      where: { track: true, day: { gte: period.startDay, lte: period.endDay } },
    }),
    prisma.upstreamRechargeLog.findMany({
      where: { status: "confirmed", rechargedAt: { gte: periodStart, lt: periodEnd } },
    }),
    prisma.downstreamTopup.findMany({
      select: {
        downstreamId: true,
        userId: true,
        moneyRmb: true,
        status: true,
        completedAt: true,
      },
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

  // ——— 私域 / 公共成本：按 天×模型 精确对齐 ———
  // 上游明细给 actualCost（面值），其当天冻结成本率在 UpstreamUsageDaily；
  // 下游逐条日志给同一天同模型的私域/公共消费占比。
  // 对不上的模型、快照估算成本和额外成本，仍按收入占比回退分摊。
  const privateShare =
    measuredRevenueRmb > 0 ? privateRevenueRmb / measuredRevenueRmb : 0;
  const billableKeySet = new Set(
    keys
      .filter((k) => k.countAsCost)
      .map((k) => `${k.providerId}|${k.remoteKeyId}`),
  );
  const rateByProviderKeyDay = new Map<string, number>();
  for (const d of usageDailies) {
    if (!d.countAsCost || !(d.actualCost > 0)) continue;
    rateByProviderKeyDay.set(
      `${d.providerId}|${d.remoteKeyId}|${d.day}`,
      d.costRmb / d.actualCost,
    );
  }

  // 下游模型用量：按 天|模型 聚合所有站点，再拿 PRIVATE/TOTAL 比例
  const modelQuota = new Map<string, { total: number; private: number }>();
  for (const row of downstreamModelDaily) {
    const key = `${row.day}|${row.model}`;
    const cur = modelQuota.get(key) || { total: 0, private: 0 };
    if (row.scope === "TOTAL") cur.total += row.quota || 0;
    else if (row.scope === "PRIVATE") cur.private += row.quota || 0;
    modelQuota.set(key, cur);
  }

  let privateModelCost = 0;
  let modelAllocatedCostRmb = 0;
  for (const log of upstreamUsageLogs) {
    if (!log.model) continue;
    if (!billableKeySet.has(`${log.providerId}|${log.remoteKeyId || ""}`)) continue;
    const rate = rateByProviderKeyDay.get(
      `${log.providerId}|${log.remoteKeyId || ""}|${log.day}`,
    );
    if (rate == null) continue;
    const down = modelQuota.get(`${log.day}|${log.model}`);
    if (!down || !(down.total > 0)) continue;

    const costRmb = (log.actualCost || 0) * rate;
    const modelPrivateShare = Math.min(1, Math.max(0, down.private / down.total));
    modelAllocatedCostRmb += costRmb;
    privateModelCost += costRmb * modelPrivateShare;
  }

  // 还没按模型对齐的上游成本 + 全部额外成本，按收入占比回退分摊
  const fallbackUpstreamCost = Math.max(0, upstreamCostRmb - modelAllocatedCostRmb);
  const fallbackCostRmb = round2(fallbackUpstreamCost + operatingRmb + orphan.totalRmb);
  const allocation = allocateOwnershipCosts({
    totalCostRmb,
    privateRevenueRmb,
    publicRevenueRmb,
    privateModelCostRmb: privateModelCost,
    fallbackCostRmb,
  });
  const {
    privateCostRmb,
    publicCostRmb,
    privateProfitRmb: privateProfit,
    publicProfitRmb: publicProfit,
  } = allocation;
  const modelCoveragePct =
    upstreamCostRmb > 0
      ? Math.min(100, round2((modelAllocatedCostRmb / upstreamCostRmb) * 100))
      : 0;
  const allocationSource: FinancialReport["profit"]["allocationSource"] =
    modelAllocatedCostRmb > 0 ? "model" : "revenue-share";

  if (upstreamCostRmb > 0 && modelCoveragePct < 100) {
    warnings.push(
      `私域/公共成本已有 ${modelCoveragePct.toFixed(1)}% 按模型精确对齐，其余成本仍按收入占比分摊`,
    );
  }

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
  const prepaid = summarizePrepaid(
    downstreamTopups,
    new Map(
      sites.map((site) => [
        site.id,
        {
          excludeUserIds: parseUserIds(site.excludeUserIds),
          privateUserIds: parseUserIds(site.privateUserIds),
        },
      ]),
    ),
    {
      period: { start: periodStart, end: periodEnd },
      month: currentMonth,
    },
  );
  const incompletePrepaidSites = sites.filter(
    (site) => !site.topupBackfillComplete || !!site.topupSyncError,
  );
  if (incompletePrepaidSites.length > 0) {
    warnings.push(
      `有 ${incompletePrepaidSites.length} 个下游站点的预收款历史回填不完整，累计金额可能偏低`,
    );
  }

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
      privateCostRmb,
      publicCostRmb,
      privateMarginPct:
        privateRevenueRmb > 0 ? pct(privateProfit, privateRevenueRmb) : null,
      publicMarginPct:
        publicRevenueRmb > 0 ? pct(publicProfit, publicRevenueRmb) : null,
      privateShare: round2(privateShare * 100) / 100,
      allocationSource,
      modelAllocatedCostRmb: round2(modelAllocatedCostRmb),
      fallbackCostRmb,
      modelCoveragePct,
    },
    prepaid: {
      ...prepaid,
      complete: incompletePrepaidSites.length === 0,
      incompleteSites: incompletePrepaidSites.length,
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
