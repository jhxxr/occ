import { buildChannelCostMap, type ChannelCostSignal } from "@/lib/channel-cost-map";
import { getChannelHealth } from "@/lib/channel-health";
import { buildFinancialReport } from "@/lib/financial-report";
import { resolvePeriod } from "@/lib/reporting-period";
import {
  buildOptimizationActions,
  type OptimizationAction,
} from "@/lib/channel-scheduler";
import { getDashboardData } from "@/lib/sync";

export interface OperationsChannel {
  siteId: string;
  siteName: string;
  channelId: number;
  name: string;
  group: string;
  enabled: boolean;
  health: string;
  priority: number;
  autoBan: boolean;
  models: string[];
  modelCount: number;
  requests24h: number;
  requests7d: number;
  quotaUsd24h: number;
  quotaUsd7d: number;
  issueRate24h: number | null;
  responseTimeMs: number | null;
  providerId: string | null;
  providerName: string | null;
  keyLabel: string | null;
  rateMultiplier: number | null;
  countAsCost: boolean | null;
  costMatched: boolean;
  costRank: number | null;
  costRankedCount: number;
  actionIds: string[];
}

export interface OperationsPayload {
  fetchedAt: string;
  period: { label: string; startDay: string; endDay: string };
  business: {
    revenueRmb: number;
    upstreamCostRmb: number;
    operatingCostRmb: number;
    orphanCostRmb: number;
    profitRmb: number;
    marginPct: number | null;
    upstreamBalanceRmb: number;
    prepaidBalanceRmb: number | null;
    prepaidComplete: boolean;
    requiredUpstreamCostRmb: number | null;
    additionalUpstreamInvestRmb: number | null;
    estimatedProfitRmb: number | null;
  };
  coverage: {
    measuredComplete: boolean;
    costComplete: boolean;
    costSource: string;
    matchedChannels: number;
    totalChannels: number;
    warnings: string[];
  };
  providers: {
    id: string;
    name: string;
    enabled: boolean;
    balanceRmb: number | null;
    monthCostRmb: number;
    costSharePct: number | null;
    lowBalance: boolean;
    lastSyncAt: string | null;
    lastError: string | null;
  }[];
  sites: {
    id: string;
    name: string;
    revenueRmb: number;
    requests: number;
    enabled: boolean;
    complete: boolean;
  }[];
  channels: OperationsChannel[];
  actions: OptimizationAction[];
}

function signalKey(siteId: string, channelId: number): string {
  return `${siteId}:${channelId}`;
}

function channelSignalMap(signals: ChannelCostSignal[]) {
  return new Map(
    signals.map((signal) => [signalKey(signal.siteId, signal.channelId), signal]),
  );
}

export async function getOperationsData(): Promise<OperationsPayload> {
  const period = resolvePeriod({ period: "month", offset: 0 });
  const dashboard = await getDashboardData();
  const report = await buildFinancialReport(period);
  const health = await getChannelHealth();
  const costSignals = await buildChannelCostMap();

  const signalByChannel = channelSignalMap(costSignals);
  const schedulable = health.channels.map((channel) => {
    const signal = signalByChannel.get(signalKey(channel.siteId, channel.channelId));
    return {
      siteId: channel.siteId,
      siteName: channel.siteName,
      channelId: channel.channelId,
      name: channel.name,
      group: channel.group,
      enabled: channel.enabled,
      health: channel.health,
      priority: channel.priority,
      autoBan: channel.autoBan,
      requests24h: channel.d1.requests,
      requests7d: channel.d7.requests,
      issueRate24h: channel.d1.issueRate,
      responseTimeMs: channel.responseTimeMs,
      rateMultiplier: signal?.rateMultiplier ?? null,
      costMatched: signal?.matched ?? false,
    };
  });
  const actions = buildOptimizationActions(schedulable);
  const actionsByChannel = new Map<string, string[]>();
  for (const item of actions) {
    const key = signalKey(item.siteId, item.channelId);
    const ids = actionsByChannel.get(key) || [];
    ids.push(item.id);
    actionsByChannel.set(key, ids);
  }

  const channels: OperationsChannel[] = health.channels.map((channel) => {
    const key = signalKey(channel.siteId, channel.channelId);
    const signal = signalByChannel.get(key);
    return {
      siteId: channel.siteId,
      siteName: channel.siteName,
      channelId: channel.channelId,
      name: channel.name,
      group: channel.group,
      enabled: channel.enabled,
      health: channel.health,
      priority: channel.priority,
      autoBan: channel.autoBan,
      models: channel.models,
      modelCount: channel.modelCount,
      requests24h: channel.d1.requests,
      requests7d: channel.d7.requests,
      quotaUsd24h: channel.d1.quotaUsd,
      quotaUsd7d: channel.d7.quotaUsd,
      issueRate24h: channel.d1.issueRate,
      responseTimeMs: channel.responseTimeMs,
      providerId: signal?.providerId ?? null,
      providerName: signal?.providerName ?? null,
      keyLabel: signal?.keyLabel ?? null,
      rateMultiplier: signal?.rateMultiplier ?? null,
      countAsCost: signal?.countAsCost ?? null,
      costMatched: signal?.matched ?? false,
      costRank: signal?.rankInGroup ?? null,
      costRankedCount: signal?.rankedInGroup ?? 0,
      actionIds: actionsByChannel.get(key) || [],
    };
  });

  const reportProvider = new Map(report.byProvider.map((row) => [row.id, row]));
  const totalProviderCost = report.byProvider.reduce(
    (sum, row) => sum + row.costRmb,
    0,
  );
  const providers = dashboard.providers.map((provider) => {
    const cost = reportProvider.get(provider.id)?.costRmb ?? 0;
    return {
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      balanceRmb: provider.balanceRmb,
      monthCostRmb: cost,
      costSharePct:
        totalProviderCost > 0 ? (cost / totalProviderCost) * 100 : null,
      lowBalance: provider.isLow,
      lastSyncAt: provider.lastSyncAt
        ? new Date(provider.lastSyncAt).toISOString()
        : null,
      lastError: provider.lastError,
    };
  });

  const balanceCompleteBySite = new Map(
    report.prepaid.balanceSites.map((site) => [site.id, site.complete]),
  );
  const sites = report.bySite.map((site) => ({
    id: site.id,
    name: site.name,
    revenueRmb: site.revenueRmb,
    requests: site.requests,
    enabled: site.enabled,
    complete:
      site.missingDays === 0 &&
      site.excludeResolved &&
      site.privateResolved &&
      (balanceCompleteBySite.get(site.id) ?? false),
  }));

  const matchedChannels = channels.filter((channel) => channel.costMatched).length;
  const warnings = [...report.coverage.warnings];
  if (matchedChannels < channels.length) {
    warnings.push(
      `${channels.length - matchedChannels} 个渠道未匹配到已知 Key，暂不参与成本调度`,
    );
  }

  return {
    fetchedAt: new Date().toISOString(),
    period: {
      label: report.period.label,
      startDay: report.period.startDay,
      endDay: report.period.endDay,
    },
    business: {
      revenueRmb: report.revenue.measuredRmb,
      upstreamCostRmb: report.cost.upstreamRmb,
      operatingCostRmb: report.cost.operatingRmb,
      orphanCostRmb: report.cost.orphanRmb,
      profitRmb: report.profit.measuredRmb,
      marginPct: report.profit.measuredMarginPct,
      upstreamBalanceRmb: dashboard.metrics.totalUpstreamBalanceRmb,
      prepaidBalanceRmb: report.prepaid.balanceComplete
        ? report.prepaid.current.totalRmb
        : null,
      prepaidComplete: report.prepaid.balanceComplete,
      requiredUpstreamCostRmb: report.capitalPlan.requiredUpstreamCostRmb,
      additionalUpstreamInvestRmb:
        report.capitalPlan.additionalUpstreamInvestRmb,
      estimatedProfitRmb: report.capitalPlan.estimatedProfitRmb,
    },
    coverage: {
      measuredComplete: report.coverage.measuredComplete,
      costComplete: report.coverage.costComplete,
      costSource: report.cost.source,
      matchedChannels,
      totalChannels: channels.length,
      warnings,
    },
    providers,
    sites,
    channels,
    actions,
  };
}
