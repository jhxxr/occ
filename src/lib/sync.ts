import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getSub2ProxyUrl } from "@/lib/sub2/settings";
import { fetchDownstreamStats, fetchUpstreamBalance } from "@/lib/adapters";
import { syncSub2ApiKeys } from "@/lib/sub2/sync-keys";
import { syncSub2ApiKeyProvider } from "@/lib/sub2api-key/sync";
import { detectRechargeOnSync } from "@/lib/recharge";
import {
  isSelfHosted,
  isSub2ApiKeyType,
  normalizeProviderType,
  relayOnly,
  selfHostedOnly,
} from "@/lib/provider-kinds";
import {
  syncDownstreamModelUsage,
  syncDownstreamTopups,
  syncDownstreamUsage,
} from "@/lib/downstream-usage";
import { summarizeCosts } from "@/lib/operating-cost";
import { monthPeriod, addDays, shanghaiDay, startOfMonthDay } from "@/lib/reporting-period";
import {
  syncSelfHostedMeta,
  syncSelfHostedGroupUsage,
} from "@/lib/sub2-admin/sync";
import {
  buildDailySeries,
  buildProviderShares,
  calculateProfit,
} from "@/lib/profit";

export interface SyncResultItem {
  id: string;
  name: string;
  kind: "upstream" | "downstream" | "self-hosted";
  success: boolean;
  balance?: number;
  consumed?: number;
  revenue?: number;
  error?: string;
  tokenRefreshed?: boolean;
  businessCostRmb?: number;
  billableKeys?: number;
  /** 自建站：同步到的分组 / 账号数 */
  groups?: number;
  accounts?: number;
  /** 下游：写入了几天的真实消费 */
  usageDays?: number;
  /** 下游：这几天的消费收入（人民币） */
  usageRevenueRmb?: number;
  /** 下游：日消费/倍率同步的问题（不影响余额同步成功） */
  usageError?: string;
}

export async function getUsdCnyRate(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: "usdCny" } });
  if (row) {
    const n = Number(row.value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number(process.env.DEFAULT_USD_CNY || 7.2);
}

/** 最近 n 天的 Asia/Shanghai 日期区间 */
function recentRange(days: number): { startDate: string; endDate: string } {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - Math.max(0, days - 1));
  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * 自建 Sub2API 同步 —— 走管理端 X-API-Key，跟中转上游那套完全无关。
 *
 * 不查余额（自建站没有余额）、不写 SnapshotLog、不跑充值检测。
 * 只刷分组/账号元数据，再拉已勾选统计分组的用量。
 */
export async function syncSelfHostedProvider(
  id: string,
  opts: { usageDays?: number } = {},
): Promise<SyncResultItem> {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!provider) {
    return { id, name: "?", kind: "self-hosted", success: false, error: "Not found" };
  }

  if (!provider.apiKey) {
    const error = "缺少 Admin API Key，请到「自建上游」补填";
    await prisma.upstreamProvider.update({
      where: { id },
      data: { lastError: error, lastSyncAt: new Date() },
    });
    return { id, name: provider.name, kind: "self-hosted", success: false, error };
  }

  try {
    const meta = await syncSelfHostedMeta(id);

    // 顺手拉一次已追踪分组的用量，让「全量同步」对自建站也有实际产出
    const { startDate, endDate } = recentRange(opts.usageDays ?? 7);
    await syncSelfHostedGroupUsage(id, { startDate, endDate, maxPages: 40 });

    return {
      id,
      name: provider.name,
      kind: "self-hosted",
      success: true,
      consumed: meta.officialTotal,
      groups: meta.groups,
      accounts: meta.accounts,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.upstreamProvider.update({
      where: { id },
      data: { lastError: error.slice(0, 300), lastSyncAt: new Date() },
    });
    return { id, name: provider.name, kind: "self-hosted", success: false, error };
  }
}

export async function syncUpstreamProvider(id: string): Promise<SyncResultItem> {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!provider) {
    return { id, name: "?", kind: "upstream", success: false, error: "Not found" };
  }

  if (provider.retiredAt) {
    return {
      id,
      name: provider.name,
      kind: "upstream",
      success: false,
      error: "该上游已弃用",
    };
  }

  // 自建站是另一个物种：改走管理端同步，别拿中转上游的余额探测去打它
  if (isSelfHosted(provider.type)) {
    return syncSelfHostedProvider(id);
  }

  if (isSub2ApiKeyType(provider.type)) {
    const result = await syncSub2ApiKeyProvider(id);
    return {
      id,
      name: provider.name,
      kind: "upstream",
      success: result.success,
      balance: result.balance,
      consumed: result.consumed,
      businessCostRmb:
        result.success && result.businessDelta != null
          ? result.businessDelta * provider.discountRate
          : undefined,
      billableKeys: result.billableKeys,
      error: result.error,
    };
  }

  const apiKey = provider.apiKey ? decryptSecret(provider.apiKey) : "";
  const accountPassword = provider.accountPassword
    ? decryptSecret(provider.accountPassword)
    : null;
  const refreshToken = provider.refreshToken
    ? decryptSecret(provider.refreshToken)
    : null;

  const result = await fetchUpstreamBalance({
    baseUrl: provider.baseUrl,
    apiKey,
    type: provider.type,
    quotaPerDollar: provider.quotaPerDollar,
    accountEmail: provider.accountEmail,
    accountPassword,
    refreshToken,
    tokenExpiresAt: provider.tokenExpiresAt,
    proxyUrl: provider.type === "SUB2API" ? await getSub2ProxyUrl() : null,
  });

  const tokenPatch: Record<string, unknown> = {};
  if (result.authUpdate?.accessToken) {
    tokenPatch.apiKey = encryptSecret(result.authUpdate.accessToken);
  }
  if (result.authUpdate?.refreshToken) {
    tokenPatch.refreshToken = encryptSecret(result.authUpdate.refreshToken);
  }
  if (result.authUpdate?.expiresAt !== undefined) {
    tokenPatch.tokenExpiresAt = result.authUpdate.expiresAt;
  }
  const tokenRefreshed = Object.keys(tokenPatch).length > 0;

  if (!result.success) {
    await prisma.upstreamProvider.update({
      where: { id },
      data: {
        ...tokenPatch,
        lastError: result.error || "Sync failed",
        lastSyncAt: new Date(),
      },
    });
    return {
      id,
      name: provider.name,
      kind: "upstream",
      success: false,
      error: result.error,
      tokenRefreshed,
    };
  }

  // 账号级增量（NewAPI 或未做 Key 归因时）
  const prevBalance = provider.lastBalance;
  const prevConsumed = provider.lastConsumed ?? result.consumed;
  const accountDelta = Math.max(0, result.consumed - prevConsumed);
  const isFirst = provider.lastConsumed == null && provider.lastSyncAt == null;
  let effectiveDelta = isFirst ? 0 : accountDelta;
  let costRmb = effectiveDelta * provider.discountRate;
  let billableKeys: number | undefined;
  let businessCostRmb: number | undefined;
  let costNote = "account";
  let lastError: string | null = null;
  let rechargeDetected: { detected: boolean; creditGained?: number } = {
    detected: false,
  };

  // 同步时顺带检测充值（仅在已有基线时；不额外请求，无风控压力）
  if (!isFirst && prevBalance != null && provider.lastConsumed != null) {
    try {
      rechargeDetected = await detectRechargeOnSync(
        id,
        { balance: prevBalance, consumed: provider.lastConsumed },
        { balance: result.balance, consumed: result.consumed },
      );
      if (rechargeDetected.detected) {
        lastError = `检测到充值约 ${rechargeDetected.creditGained?.toFixed(2)} 面值，请到「充值台账」补填实付金额`;
      }
    } catch {
      // ignore detection errors
    }
  }

  // Sub2API：按勾选「计入中转」的 Key 实际扣费做精准成本
  if (provider.type === "SUB2API") {
    try {
      if (Object.keys(tokenPatch).length) {
        await prisma.upstreamProvider.update({ where: { id }, data: tokenPatch });
      }
      const keySync = await syncSub2ApiKeys(id);
      billableKeys = keySync.billableKeys;
      effectiveDelta = keySync.businessDeltaUsd;
      costRmb = keySync.businessDeltaUsd * provider.discountRate;
      businessCostRmb = costRmb;
      costNote = keySync.billableKeys > 0 ? "keys" : "keys-none-selected";
      if (keySync.billableKeys === 0 && !rechargeDetected.detected) {
        lastError =
          "已同步；请在「密钥/分组」勾选用于中转的 API Key，否则业务成本为 0";
      } else if (keySync.billableKeys === 0 && rechargeDetected.detected) {
        // 保留充值提示
      } else if (rechargeDetected.detected) {
        lastError = `检测到充值约 ${rechargeDetected.creditGained?.toFixed(2)} 面值，请到「充值台账」补填实付`;
      } else if (keySync.missingStats > 0) {
        // 基线已保留（不会凭空多算成本），但这轮的增量是不完整的
        lastError = `有 ${keySync.missingStats} 个 Key 没拿到用量数据，本轮成本可能偏低，建议稍后重新同步`;
      } else if (keySync.baselineResets > 0) {
        lastError = `有 ${keySync.baselineResets} 个 Key 的上游累计消费低于上次记录（对方可能重置了计数），本轮未计入这部分增量`;
      } else {
        lastError = null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      costNote = "keys-fallback";
      lastError = `Key 用量同步失败，已回退整号消耗：${msg.slice(0, 120)}`;
    }
  }

  await prisma.$transaction([
    prisma.snapshotLog.create({
      data: {
        upstreamId: id,
        balance: result.balance,
        consumed: result.consumed,
        deltaConsumed: effectiveDelta,
        costRmb,
        raw: JSON.stringify({
          costNote,
          billableKeys,
          businessDeltaUsd: effectiveDelta,
        }).slice(0, 4000),
      },
    }),
    prisma.upstreamProvider.update({
      where: { id },
      data: {
        ...tokenPatch,
        lastBalance: result.balance,
        lastConsumed: result.consumed,
        lastSyncAt: new Date(),
        lastError,
      },
    }),
  ]);

  return {
    id,
    name: provider.name,
    kind: "upstream",
    success: true,
    balance: result.balance,
    consumed: result.consumed,
    tokenRefreshed,
    businessCostRmb,
    billableKeys,
  };
}

export async function syncDownstreamSite(id: string): Promise<SyncResultItem> {
  const site = await prisma.downstreamSite.findUnique({ where: { id } });
  if (!site) {
    return { id, name: "?", kind: "downstream", success: false, error: "Not found" };
  }

  const adminKey = decryptSecret(site.adminKey);
  let excludeUserIds: number[] = [];
  try {
    const parsed = JSON.parse(site.excludeUserIds || "[]");
    if (Array.isArray(parsed)) {
      excludeUserIds = parsed.map(Number).filter((n) => Number.isFinite(n));
    }
  } catch {
    excludeUserIds = [];
  }

  const result = await fetchDownstreamStats({
    baseUrl: site.baseUrl,
    adminKey,
    adminUserId: site.adminUserId ?? 1,
    quotaPerDollar: site.quotaPerDollar ?? 500000,
    excludeUserIds,
    revenueCurrency: site.revenueCurrency === "USD" ? "USD" : "CNY",
  });

  if (!result.success) {
    await prisma.downstreamSite.update({
      where: { id },
      data: { lastError: result.error || "Sync failed", lastSyncAt: new Date() },
    });
    return {
      id,
      name: site.name,
      kind: "downstream",
      success: false,
      error: result.error,
    };
  }

  await prisma.$transaction([
    prisma.downstreamSnapshot.create({
      data: {
        downstreamId: id,
        consumed: result.consumed,
        revenue: result.revenue,
        revenueCurrency: result.revenueCurrency,
        raw: result.raw ? JSON.stringify(result.raw).slice(0, 8000) : null,
      },
    }),
    prisma.downstreamSite.update({
      where: { id },
      data: {
        lastConsumed: result.consumed,
        lastRevenue: result.revenue,
        lastSyncAt: new Date(),
        lastError: null,
      },
    }),
  ]);

  // 顺带补最近几天的真实消费与分组倍率 —— 周/月收益报表只认这套日数据
  let usageDays: number | undefined;
  let usageRevenueRmb: number | undefined;
  let usageError: string | undefined;
  try {
    const usage = await syncDownstreamUsage(id, { days: 7 });
    if (usage.success) {
      usageDays = usage.days;
      usageRevenueRmb = usage.revenueRmb;
      // 收入同步成功后，顺带补同区间的模型×归属用量，供毛利按模型对齐。
      const modelUsage = await syncDownstreamModelUsage(id, { days: 7 });
      if (!modelUsage.success) {
        usageError = `模型用量同步失败：${modelUsage.error || "未知错误"}`;
      }
    } else {
      usageError = usage.error;
    }
    const topups = await syncDownstreamTopups(id);
    if (!topups.success || !topups.complete) {
      const topupError = `预收款同步失败：${topups.error || "历史回填不完整"}`;
      usageError = usageError ? `${usageError}；${topupError}` : topupError;
    }
  } catch (e) {
    usageError = e instanceof Error ? e.message : String(e);
  }

  return {
    id,
    name: site.name,
    kind: "downstream",
    success: true,
    consumed: result.consumed,
    revenue: result.revenue,
    usageDays,
    usageRevenueRmb,
    usageError,
  };
}

/** Full sync of all enabled providers & sites */
export async function syncAll(): Promise<SyncResultItem[]> {
  const [relays, selfHosted, downstreams] = await Promise.all([
    prisma.upstreamProvider.findMany({ where: { enabled: true, ...relayOnly } }),
    prisma.upstreamProvider.findMany({
      where: { enabled: true, ...selfHostedOnly },
    }),
    prisma.downstreamSite.findMany({ where: { enabled: true } }),
  ]);

  const results: SyncResultItem[] = [];
  for (const u of relays) {
    results.push(await syncUpstreamProvider(u.id));
  }
  for (const s of selfHosted) {
    results.push(await syncSelfHostedProvider(s.id));
  }
  for (const d of downstreams) {
    results.push(await syncDownstreamSite(d.id));
  }
  return results;
}

/** Aggregate dashboard payload for the UI */
export async function getDashboardData() {
  const usdCny = await getUsdCnyRate();
  const now = new Date();

  // 边界统一走北京日历日再换算成真实时刻。
  // 之前 monthStart 用的是「容器本地零点」，而按日聚合查询用的是北京日字符串，
  // UTC 容器里两者差 8 小时 —— 每月头 8 小时的快照成本会被漏掉。
  const todayDay = shanghaiDay(now);
  const monthStartDay = startOfMonthDay(todayDay);
  const seriesStartDay = addDays(todayDay, -29);

  const dayStartInstant = (day: string) => new Date(`${day}T00:00:00+08:00`);
  const monthStart = dayStartInstant(monthStartDay);
  const seriesStart = dayStartInstant(seriesStartDay);

  // 先分身份：中转上游（余额/预警/成本占比）与自建站（独立一套账）
  const [providers, selfHostedSites] = await Promise.all([
    prisma.upstreamProvider.findMany({
      where: relayOnly,
      orderBy: { createdAt: "asc" },
    }),
    prisma.upstreamProvider.findMany({
      where: selfHostedOnly,
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // 成本口径只认中转上游。曾被误建成第三方的自建站可能留着旧快照，按 id 排除。
  const relayIds = providers.map((p) => p.id);

  const [sites, costSnaps, monthCosts, usageMonthAgg, usageDailies] =
    await Promise.all([
      prisma.downstreamSite.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.snapshotLog.findMany({
        where: { upstreamId: { in: relayIds }, timestamp: { gte: seriesStart } },
        orderBy: { timestamp: "asc" },
      }),
      prisma.snapshotLog.findMany({
        where: { upstreamId: { in: relayIds }, timestamp: { gte: monthStart } },
      }),
      // 本月：已勾选中转 Key 的使用记录成本
      prisma.upstreamUsageDaily.aggregate({
        where: {
          providerId: { in: relayIds },
          countAsCost: true,
          day: { gte: monthStartDay, lte: todayDay },
        },
        _sum: { costRmb: true, actualCost: true, requests: true, totalTokens: true },
        _count: true,
      }),
      prisma.upstreamUsageDaily.findMany({
        where: {
          providerId: { in: relayIds },
          countAsCost: true,
          day: { gte: seriesStartDay, lte: todayDay },
        },
        orderBy: { day: "asc" },
      }),
    ]);

  const usageMonthCost = usageMonthAgg._sum.costRmb ?? 0;
  const usageMonthRequests = usageMonthAgg._sum.requests ?? 0;
  const hasUsageCost = (usageMonthAgg._count as number) > 0 || usageDailies.length > 0;

  // 成本口径与收益报表保持一致：按「站点 × 日」取精确用量，
  // 只有那天该站点没有 Key 级日志时才补快照估算。
  // 不能全局二选一 —— 否则一个站点有精确日志就会把其它站点的快照成本整体丢掉。
  const preciseProviderDays = new Set(
    usageDailies.map((d) => `${d.providerId}|${d.day}`),
  );
  const toShanghai = (d: Date) => shanghaiDay(d);
  const snapshotFallbackCost = monthCosts.reduce((sum, snap) => {
    if (preciseProviderDays.has(`${snap.upstreamId}|${toShanghai(snap.timestamp)}`)) {
      return sum;
    }
    return sum + (snap.costRmb || 0);
  }, 0);

  const businessCostRmb = usageMonthCost + snapshotFallbackCost;
  const costSource =
    usageMonthCost > 0 && snapshotFallbackCost > 0
      ? "mixed"
      : usageMonthCost > 0
        ? "usage-logs"
        : "snapshots";

  const monthSummary = calculateProfit({
    costPoints: monthCosts.map((s) => ({
      timestamp: s.timestamp,
      costRmb: s.costRmb,
      deltaConsumed: s.deltaConsumed,
      upstreamId: s.upstreamId,
    })),
    revenuePoints: [],
    upstreamBalances: providers
      .filter((p) => p.enabled)
      .map((p) => ({
        balanceUsd: p.lastBalance ?? 0,
        discountRate: p.discountRate,
      })),
    periodStart: monthStart,
    periodEnd: now,
    usdCny,
  });

  // 下游收入：本月付费账号的真实消费。
  // 测试号的消费单独存 grossRevenueRmb —— 它烧了上游额度但没人付钱，
  // 算进收入就是虚增利润；那个数只用于跟上游成本对差值。
  const monthUsage = await prisma.downstreamUsageDaily.aggregate({
    where: {
      scope: "TOTAL",
      day: { gte: monthStartDay, lte: todayDay },
    },
    _sum: { revenueRmb: true, grossRevenueRmb: true, requests: true },
    _count: true,
  });
  const totalRevenueRmb = monthUsage._sum.revenueRmb ?? 0;
  const grossConsumptionRmb = monthUsage._sum.grossRevenueRmb ?? 0;
  const excludedRevenueRmb = Math.max(0, grossConsumptionRmb - totalRevenueRmb);
  const hasUsageRevenue = (monthUsage._count as number) > 0;

  // 已发放额度：存量参考值，跟收益无关
  const issuedCreditRmb = sites.reduce((sum, site) => {
    const rev = site.lastRevenue ?? 0;
    if (!rev) return sum;
    if (site.revenueCurrency === "USD") return sum + rev * usdCny;
    return sum + rev;
  }, 0);

  // 本月额外成本台账（自建号采购/订阅），一次性按记账日、期间按天摊销
  const costEntries = await prisma.operatingCostEntry.findMany({
    where: { status: { not: "void" } },
  });
  const monthCostSummary = summarizeCosts(
    costEntries.map((e) => ({
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
    })),
    monthPeriod(todayDay),
  );
  const operatingCostRmb = monthCostSummary.totalRmb;

  const netProfitRmb = totalRevenueRmb - businessCostRmb - operatingCostRmb;

  // —— 图表：同样按「站点 × 日」精确优先、缺日补快照 ——
  const costByDayForChart = new Map<string, number>();
  for (const d of usageDailies) {
    costByDayForChart.set(
      d.day,
      (costByDayForChart.get(d.day) || 0) + (d.costRmb || 0),
    );
  }
  for (const snap of costSnaps) {
    const day = toShanghai(snap.timestamp);
    if (preciseProviderDays.has(`${snap.upstreamId}|${day}`)) continue;
    if (!(snap.costRmb > 0)) continue;
    costByDayForChart.set(day, (costByDayForChart.get(day) || 0) + snap.costRmb);
  }

  // 收入按日真实消费，不再用「已发放额度」的快照差分
  const seriesRevenue = await prisma.downstreamUsageDaily.findMany({
    where: {
      scope: "TOTAL",
      day: { gte: seriesStartDay, lte: todayDay },
    },
    orderBy: { day: "asc" },
  });
  const revByDay = new Map<string, number>();
  for (const row of seriesRevenue) {
    revByDay.set(row.day, (revByDay.get(row.day) || 0) + (row.revenueRmb || 0));
  }

  // 日聚合表里的 day 已经是北京日历日，直接透传给图表 ——
  // 绕一趟 new Date(`${day}T12:00:00`) 会按容器本地时区解释，白白引入时区误差
  const costPointsForChart = [...costByDayForChart.entries()].map(
    ([day, costRmb]) => ({
      timestamp: day,
      costRmb,
      deltaConsumed: 0,
    }),
  );

  const dailySeries = buildDailySeries(
    costPointsForChart,
    [...revByDay.entries()].map(([date, revenueRmb]) => ({
      timestamp: date,
      revenue: revenueRmb,
      revenueCurrency: "CNY" as const,
    })),
    30,
    usdCny,
  );

  // 成本占比：每个站点各自取精确用量，缺日的那部分补自己的快照
  const costByProvider = new Map<string, number>();
  for (const d of usageDailies) {
    if (!d.countAsCost) continue;
    costByProvider.set(
      d.providerId,
      (costByProvider.get(d.providerId) || 0) + (d.costRmb || 0),
    );
  }
  for (const snap of monthCosts) {
    if (preciseProviderDays.has(`${snap.upstreamId}|${toShanghai(snap.timestamp)}`)) {
      continue;
    }
    if (!(snap.costRmb > 0)) continue;
    costByProvider.set(
      snap.upstreamId,
      (costByProvider.get(snap.upstreamId) || 0) + snap.costRmb,
    );
  }

  const providerShares = buildProviderShares(
    providers.map((p) => ({
      id: p.id,
      name: p.name,
      lastConsumed: p.lastConsumed,
      lastBalance: p.lastBalance,
      discountRate: p.discountRate,
    })),
    [...costByProvider.entries()].map(([upstreamId, costRmb]) => ({
      upstreamId,
      costRmb,
      deltaConsumed: 0,
    })),
  );

  const alerts = providers
    .filter(
      (p) =>
        p.enabled &&
        p.lastBalance != null &&
        p.lastBalance < p.alertThreshold,
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      balance: p.lastBalance!,
      threshold: p.alertThreshold,
      balanceRmb: p.lastBalance! * p.discountRate,
      thresholdRmb: p.alertThreshold * p.discountRate,
    }));

  const billableKeyCount = await prisma.upstreamApiKey.count({
    where: { countAsCost: true },
  });

  // —— 自建上游：官方用量 × 卖出倍率 vs 账号采购成本 ——
  const selfHostedIds = selfHostedSites.map((s) => s.id);
  const [shGroups, shAccounts, shMonthDaily] = selfHostedIds.length
    ? await Promise.all([
        prisma.selfHostedGroup.findMany({
          where: { providerId: { in: selfHostedIds } },
        }),
        prisma.selfHostedAccount.findMany({
          where: { providerId: { in: selfHostedIds } },
        }),
        prisma.selfHostedGroupDaily.findMany({
          where: {
            providerId: { in: selfHostedIds },
            track: true,
            day: { gte: monthStartDay, lte: todayDay },
          },
        }),
      ])
    : [[], [], []];

  const selfHosted = selfHostedSites.map((s) => {
    const groups = shGroups.filter((g) => g.providerId === s.id);
    const accounts = shAccounts.filter((a) => a.providerId === s.id);
    const daily = shMonthDaily.filter((d) => d.providerId === s.id);
    const trackedAccounts = accounts.filter((a) => a.track);

    const monthOfficialCost = daily.reduce((sum, d) => sum + d.officialCost, 0);
    const monthSellRevenueRmb = daily.reduce((sum, d) => sum + d.sellRevenueRmb, 0);
    const monthRequests = daily.reduce((sum, d) => sum + d.requests, 0);
    const accountPurchaseRmb = trackedAccounts.reduce(
      (sum, a) => sum + (a.purchaseCostRmb || 0),
      0,
    );
    const accountIds = new Set(accounts.map((a) => a.id));
    const operatingCostRmb = monthCostSummary.entries
      .filter(
        (e) =>
          e.providerId === s.id || (e.accountId && accountIds.has(e.accountId)),
      )
      .reduce((sum, e) => sum + e.allocatedRmb, 0);

    return {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      enabled: s.enabled,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
      /** 管理端 dashboard 报的官方累计用量面值 */
      lastConsumed: s.lastConsumed,
      hasAdminKey: !!s.apiKey,
      groupCount: groups.length,
      accountCount: accounts.length,
      trackedGroups: groups.filter((g) => g.track).length,
      trackedAccounts: trackedAccounts.length,
      monthOfficialCost,
      monthSellRevenueRmb,
      monthRequests,
      accountPurchaseRmb,
      /** 本月实际入账 / 摊销的额外成本（来自成本台账） */
      operatingCostRmb,
    };
  });

  const selfHostedTotals = selfHosted.reduce(
    (acc, s) => ({
      sites: acc.sites + 1,
      monthOfficialCost: acc.monthOfficialCost + s.monthOfficialCost,
      monthSellRevenueRmb: acc.monthSellRevenueRmb + s.monthSellRevenueRmb,
      accountPurchaseRmb: acc.accountPurchaseRmb + s.accountPurchaseRmb,
      operatingCostRmb: acc.operatingCostRmb + s.operatingCostRmb,
      monthRequests: acc.monthRequests + s.monthRequests,
    }),
    {
      sites: 0,
      monthOfficialCost: 0,
      monthSellRevenueRmb: 0,
      accountPurchaseRmb: 0,
      operatingCostRmb: 0,
      monthRequests: 0,
    },
  );

  return {
    usdCny,
    metrics: {
      totalUpstreamBalanceUsd: monthSummary.totalUpstreamBalanceUsd,
      totalUpstreamBalanceRmb: monthSummary.totalUpstreamBalanceRmb,
      monthCostRmb: businessCostRmb,
      monthRevenueRmb: totalRevenueRmb,
      monthProfitRmb: netProfitRmb,
      marginPct:
        totalRevenueRmb > 0 ? (netProfitRmb / totalRevenueRmb) * 100 : null,
      costSource,
      usageMonthRequests,
      billableKeyCount,
      hasUsageCost,
      /** 本月是否已同步到下游真实消费；没有就说明收入口径缺数据 */
      hasUsageRevenue,
      /** 额外成本台账（自建号采购/订阅）本月入账额 */
      operatingCostRmb,
      /** 当前已发放给用户的额度（存量参考，不计入收益） */
      issuedCreditRmb,
      /** 全部账号消费（含测试号）：跟上游成本对差值用，不是收入 */
      grossConsumptionRmb,
      /** 测试号烧掉的额度，已从收入剔除 */
      excludedRevenueRmb,
    },
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      type: normalizeProviderType(p.type),
      discountRate: p.discountRate,
      currency: p.currency,
      alertThreshold: p.alertThreshold,
      enabled: p.enabled,
      lastBalance: p.lastBalance,
      lastConsumed: p.lastConsumed,
      lastBusinessConsumed: p.lastBusinessConsumed,
      lastSyncAt: p.lastSyncAt,
      lastError: p.lastError,
      balanceRmb:
        p.lastBalance != null ? p.lastBalance * p.discountRate : null,
      isLow: p.lastBalance != null && p.lastBalance < p.alertThreshold,
    })),
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      enabled: s.enabled,
      revenueCurrency: s.revenueCurrency || "CNY",
      lastConsumed: s.lastConsumed,
      /** 当前已发放额度（存量，不是收益） */
      lastRevenue: s.lastRevenue,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
    })),
    selfHosted,
    selfHostedTotals,
    dailySeries,
    providerShares,
    alerts,
  };
}
