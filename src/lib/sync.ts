import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { fetchDownstreamStats, fetchUpstreamBalance } from "@/lib/adapters";
import { syncSub2ApiKeys } from "@/lib/sub2/sync-keys";
import { detectRechargeOnSync } from "@/lib/recharge";
import {
  buildDailySeries,
  buildProviderShares,
  calculateProfit,
  daysAgo,
  startOfMonth,
} from "@/lib/profit";

export interface SyncResultItem {
  id: string;
  name: string;
  kind: "upstream" | "downstream";
  success: boolean;
  balance?: number;
  consumed?: number;
  revenue?: number;
  error?: string;
  tokenRefreshed?: boolean;
  businessCostRmb?: number;
  billableKeys?: number;
}

export async function getUsdCnyRate(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: "usdCny" } });
  if (row) {
    const n = Number(row.value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number(process.env.DEFAULT_USD_CNY || 7.2);
}

export async function syncUpstreamProvider(id: string): Promise<SyncResultItem> {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!provider) {
    return { id, name: "?", kind: "upstream", success: false, error: "Not found" };
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

  return {
    id,
    name: site.name,
    kind: "downstream",
    success: true,
    consumed: result.consumed,
    revenue: result.revenue,
  };
}

/** Full sync of all enabled providers & sites */
export async function syncAll(): Promise<SyncResultItem[]> {
  const [upstreams, downstreams] = await Promise.all([
    prisma.upstreamProvider.findMany({ where: { enabled: true } }),
    prisma.downstreamSite.findMany({ where: { enabled: true } }),
  ]);

  const results: SyncResultItem[] = [];
  for (const u of upstreams) {
    results.push(await syncUpstreamProvider(u.id));
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
  const monthStart = startOfMonth(now);
  const seriesStart = daysAgo(30);

  const toDay = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  const monthStartDay = toDay(monthStart);
  const todayDay = toDay(now);
  const seriesStartDay = toDay(seriesStart);

  const [providers, sites, costSnaps, revSnaps, monthCosts, usageMonthAgg, usageDailies] =
    await Promise.all([
      prisma.upstreamProvider.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.downstreamSite.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.snapshotLog.findMany({
        where: { timestamp: { gte: seriesStart } },
        orderBy: { timestamp: "asc" },
      }),
      prisma.downstreamSnapshot.findMany({
        where: { timestamp: { gte: seriesStart } },
        orderBy: { timestamp: "asc" },
      }),
      prisma.snapshotLog.findMany({
        where: { timestamp: { gte: monthStart } },
      }),
      // 本月：已勾选中转 Key 的使用记录成本
      prisma.upstreamUsageDaily.aggregate({
        where: {
          countAsCost: true,
          day: { gte: monthStartDay, lte: todayDay },
        },
        _sum: { costRmb: true, actualCost: true, requests: true, totalTokens: true },
        _count: true,
      }),
      prisma.upstreamUsageDaily.findMany({
        where: {
          countAsCost: true,
          day: { gte: seriesStartDay, lte: todayDay },
        },
        orderBy: { day: "asc" },
      }),
    ]);

  const snapshotMonthCost = monthCosts.reduce((s, c) => s + (c.costRmb || 0), 0);
  const usageMonthCost = usageMonthAgg._sum.costRmb ?? 0;
  const usageMonthRequests = usageMonthAgg._sum.requests ?? 0;
  const hasUsageCost = (usageMonthAgg._count as number) > 0 || usageDailies.length > 0;

  // 优先用使用记录库（按 Key + 时间，最准）；没有同步记录时回退 SnapshotLog
  const businessCostRmb = hasUsageCost ? usageMonthCost : snapshotMonthCost;
  const costSource = hasUsageCost ? "usage-logs" : "snapshots";

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

  // 下游收入：当前已发放额度（人民币 1:1 或美元×汇率）
  const totalRevenueRmb = sites.reduce((sum, site) => {
    const rev = site.lastRevenue ?? 0;
    if (!rev) return sum;
    if (site.revenueCurrency === "USD") return sum + rev * usdCny;
    return sum + rev;
  }, 0);

  const netProfitRmb = totalRevenueRmb - businessCostRmb;

  // —— 图表：成本优先用 usage daily ——
  const costByDayFromUsage = new Map<string, number>();
  for (const d of usageDailies) {
    costByDayFromUsage.set(
      d.day,
      (costByDayFromUsage.get(d.day) || 0) + (d.costRmb || 0),
    );
  }

  const revByDay = new Map<string, number>();
  const snapsBySite = new Map<string, typeof revSnaps>();
  for (const s of revSnaps) {
    const arr = snapsBySite.get(s.downstreamId) || [];
    arr.push(s);
    snapsBySite.set(s.downstreamId, arr);
  }
  for (const [, arr] of snapsBySite) {
    const sorted = [...arr].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const prev = i > 0 ? sorted[i - 1] : null;
      const site = sites.find((x) => x.id === cur.downstreamId);
      const rawDelta = prev ? cur.revenue - prev.revenue : 0;
      if (rawDelta === 0) continue;
      const deltaRmb =
        (cur.revenueCurrency || site?.revenueCurrency) === "USD"
          ? rawDelta * usdCny
          : rawDelta;
      const key = cur.timestamp.toISOString().slice(0, 10);
      revByDay.set(key, (revByDay.get(key) || 0) + deltaRmb);
    }
  }

  const costPointsForChart =
    costByDayFromUsage.size > 0
      ? [...costByDayFromUsage.entries()].map(([day, costRmb]) => ({
          timestamp: new Date(`${day}T12:00:00`),
          costRmb,
          deltaConsumed: 0,
        }))
      : costSnaps.map((s) => ({
          timestamp: s.timestamp,
          costRmb: s.costRmb,
          deltaConsumed: s.deltaConsumed,
        }));

  const dailySeries = buildDailySeries(
    costPointsForChart,
    [...revByDay.entries()].map(([date, revenueRmb]) => ({
      timestamp: new Date(`${date}T12:00:00`),
      revenue: revenueRmb,
      revenueCurrency: "CNY" as const,
    })),
    30,
    usdCny,
  );

  // 成本占比：有 usage 时按 key 归属到 provider（目前 usage 挂在 provider 下）
  const usageCostByProvider = new Map<string, number>();
  if (hasUsageCost) {
    const monthUsage = await prisma.upstreamUsageDaily.groupBy({
      by: ["providerId"],
      where: {
        countAsCost: true,
        day: { gte: monthStartDay, lte: todayDay },
      },
      _sum: { costRmb: true, actualCost: true },
    });
    for (const row of monthUsage) {
      usageCostByProvider.set(row.providerId, row._sum.costRmb ?? 0);
    }
  }

  const providerShares = buildProviderShares(
    providers.map((p) => ({
      id: p.id,
      name: p.name,
      lastConsumed: p.lastConsumed,
      lastBalance: p.lastBalance,
      discountRate: p.discountRate,
    })),
    hasUsageCost
      ? [...usageCostByProvider.entries()].map(([upstreamId, costRmb]) => ({
          upstreamId,
          costRmb,
          deltaConsumed: 0,
        }))
      : monthCosts.map((s) => ({
          upstreamId: s.upstreamId,
          costRmb: s.costRmb,
          deltaConsumed: s.deltaConsumed,
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
    },
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      type: p.type,
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
      lastRevenue: s.lastRevenue,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
    })),
    dailySeries,
    providerShares,
    alerts,
  };
}
