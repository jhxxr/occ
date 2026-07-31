"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
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

function SectionHeading({
  title,
  description,
  meta,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border-subtle pb-2.5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p>
        )}
      </div>
      {meta && <div className="text-xs text-muted font-data">{meta}</div>}
    </div>
  );
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
      <div className="space-y-6" role="status" aria-live="polite">
        <div className="space-y-2 border-b border-border-subtle pb-5">
          <div className="h-3 w-28 animate-pulse rounded bg-surface-3" />
          <div className="h-7 w-52 animate-pulse rounded bg-surface-3" />
          <div className="h-4 w-full max-w-lg animate-pulse rounded bg-surface-3" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-36 animate-pulse rounded-lg border border-border-subtle bg-surface"
            />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-lg border border-border-subtle bg-surface" />
        <span className="sr-only">正在加载总览数据</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-coral/30 bg-coral/5 p-6 text-sm text-coral" role="alert">
        {error || "无数据"}
      </div>
    );
  }

  return (
    <div className="space-y-8">
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

      <section className="grid gap-4 xl:grid-cols-3" aria-label="经营趋势">
        <TrendChart data={data.dailySeries} />
        <SharePie data={data.providerShares} />
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="中转上游"
          description="供应商余额、购入成本与同步状态"
          meta={`${data.providers.filter((p) => p.enabled).length} 个启用`}
        />
        <ProviderGrid providers={data.providers} onSynced={load} />
      </section>

      <section className="space-y-3">
        <SectionHeading
          title="下游自营站"
          description="余额快照与最近 7 天真实消费"
          meta={`${data.sites.filter((s) => s.enabled).length} 个启用`}
        />
        <DownstreamGrid
          sites={data.sites}
          usdCny={data.usdCny}
          onSynced={load}
        />
      </section>

      {data.selfHosted.length > 0 && (
        <section className="space-y-3">
          <SectionHeading
            title="自建上游"
            description="卖出估算仅作参考，实际成本以成本台账为准"
            meta={
              <>
                卖出估算 {formatRmb(data.selfHostedTotals.monthSellRevenueRmb)} ·
                成本入账 {formatRmb(data.selfHostedTotals.operatingCostRmb)}
              </>
            }
          />
          <SelfHostedGrid sites={data.selfHosted} onSynced={load} />
        </section>
      )}
    </div>
  );
}
