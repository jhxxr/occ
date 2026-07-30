"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { MetricsRow } from "@/components/dashboard/metric-cards";
import { ProviderGrid, type ProviderCardData } from "@/components/dashboard/provider-grid";
import {
  SelfHostedGrid,
  type SelfHostedCardData,
} from "@/components/dashboard/self-hosted-grid";
import {
  DownstreamGrid,
  type DownstreamCardData,
} from "@/components/dashboard/downstream-grid";
import { TrendChart, SharePie } from "@/components/dashboard/charts";
import { AlertsBanner } from "@/components/dashboard/alerts-banner";
import { formatRmb } from "@/lib/utils";

interface DashboardPayload {
  usdCny: number;
  metrics: {
    totalUpstreamBalanceUsd: number;
    totalUpstreamBalanceRmb: number;
    monthCostRmb: number;
    monthRevenueRmb: number;
    monthProfitRmb: number;
    marginPct: number | null;
    costSource?: string;
    usageMonthRequests?: number;
    billableKeyCount?: number;
    hasUsageCost?: boolean;
    hasUsageRevenue?: boolean;
    operatingCostRmb?: number;
    issuedCreditRmb?: number;
    grossConsumptionRmb?: number;
    excludedRevenueRmb?: number;
  };
  providers: ProviderCardData[];
  selfHosted: SelfHostedCardData[];
  selfHostedTotals: {
    sites: number;
    monthOfficialCost: number;
    monthSellRevenueRmb: number;
    accountPurchaseRmb: number;
    operatingCostRmb: number;
    monthRequests: number;
  };
  sites: DownstreamCardData[];
  dailySeries: {
    date: string;
    costRmb: number;
    revenueRmb: number;
    profitRmb: number;
  }[];
  providerShares: {
    id: string;
    name: string;
    consumedUsd: number;
    costRmb: number;
    balanceUsd: number;
  }[];
  alerts: {
    id: string;
    name: string;
    balance: number;
    threshold: number;
    balanceRmb?: number;
    thresholdRmb?: number;
  }[];
}

export function DashboardView() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setData(json.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-cyan" />
          <p className="text-sm text-muted">正在接入轨道数据…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-coral/30 bg-coral/5 p-6 text-sm text-coral">
        {error || "无数据"}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="资金轨道总览"
        subtitle={
          data.metrics.hasUsageRevenue
            ? `本月收入为付费账号真实消费 · 成本来自「计入中转」Key${data.metrics.billableKeyCount ? ` ×${data.metrics.billableKeyCount}` : ""}`
            : `请先同步下游消费数据；充值与已发放额度都不算收入`
        }
        onSynced={load}
      />

      <AlertsBanner alerts={data.alerts} />
      <MetricsRow metrics={data.metrics} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium tracking-wide text-secondary">
            中转上游
          </h2>
          <span className="text-xs text-muted font-data">
            {data.providers.filter((p) => p.enabled).length} 在线配置
          </span>
        </div>
        <ProviderGrid providers={data.providers} onSynced={load} />
      </section>

      {data.selfHosted.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium tracking-wide text-secondary">
                自建上游
              </h2>
              <p className="text-[11px] text-muted">
                自己部署的 Sub2API，管理员 Key 直连管理端 · 卖出估算不计入总账，成本走成本台账
              </p>
            </div>
            <span className="text-xs text-muted font-data">
              本月卖出估算 {formatRmb(data.selfHostedTotals.monthSellRevenueRmb)} ·
              成本入账 {formatRmb(data.selfHostedTotals.operatingCostRmb)}
            </span>
          </div>
          <SelfHostedGrid sites={data.selfHosted} onSynced={load} />
        </section>
      )}

      <section className="grid gap-4 xl:grid-cols-3">
        <TrendChart data={data.dailySeries} />
        <SharePie data={data.providerShares} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium tracking-wide text-secondary">
              下游自营站
            </h2>
            <p className="text-[11px] text-muted">
              同步会拉余额快照 + 最近 7 天的真实消费（收入口径）
            </p>
          </div>
          <span className="text-xs text-muted font-data">
            {data.sites.filter((s) => s.enabled).length} 在线
          </span>
        </div>
        <DownstreamGrid
          sites={data.sites}
          usdCny={data.usdCny}
          onSynced={load}
        />
      </section>
    </div>
  );
}
