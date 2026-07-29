"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { MetricsRow } from "@/components/dashboard/metric-cards";
import { ProviderGrid, type ProviderCardData } from "@/components/dashboard/provider-grid";
import {
  SelfHostedGrid,
  type SelfHostedCardData,
} from "@/components/dashboard/self-hosted-grid";
import { TrendChart, SharePie } from "@/components/dashboard/charts";
import { AlertsBanner } from "@/components/dashboard/alerts-banner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRmb } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  };
  providers: ProviderCardData[];
  selfHosted: SelfHostedCardData[];
  selfHostedTotals: {
    sites: number;
    monthOfficialCost: number;
    monthSellRevenueRmb: number;
    accountPurchaseRmb: number;
    monthRequests: number;
  };
  sites: {
    id: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    revenueCurrency?: string;
    lastConsumed: number | null;
    lastRevenue: number | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }[];
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
          data.metrics.hasUsageCost
            ? `本月成本来自「计入中转」Key 的使用记录 · ${data.metrics.billableKeyCount ?? 0} 个 Key · ${data.metrics.usageMonthRequests ?? 0} 次请求`
            : `请到上游「使用记录库」同步本月数据，以计算精准中转成本与净利润`
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
                自己部署的 Sub2API，管理员 Key 直连管理端 · 不计入上面的余额与净利润
              </p>
            </div>
            <span className="text-xs text-muted font-data">
              本月卖出 {formatRmb(data.selfHostedTotals.monthSellRevenueRmb)} ·
              采购 {formatRmb(data.selfHostedTotals.accountPurchaseRmb)}
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
        <h2 className="text-sm font-medium tracking-wide text-secondary">
          下游自营站
        </h2>
        {data.sites.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted">
              尚未绑定下游 NewAPI 站点 · 前往「下游站点」配置
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.sites.map((s) => (
              <Card key={s.id}>
                <CardHeader className="flex flex-row items-center justify-between pb-2 gap-2">
                  <CardTitle className="text-base font-semibold text-text normal-case tracking-normal">
                    {s.name}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant={s.enabled ? "mint" : "default"}>
                      {s.enabled ? "启用" : "停用"}
                    </Badge>
                    <a
                      href={s.baseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="打开网站"
                    >
                      <Button size="icon" variant="outline" aria-label="打开网站">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted">
                      最近消耗
                    </div>
                    <div className="font-data text-lg">
                      {formatRmb(s.lastConsumed)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-muted">
                      最近收入
                    </div>
                    <div className="font-data text-lg">
                      {s.revenueCurrency === "USD"
                        ? formatRmb(
                            s.lastRevenue != null
                              ? s.lastRevenue * data.usdCny
                              : null,
                          )
                        : formatRmb(s.lastRevenue)}
                    </div>
                  </div>
                  <div className="col-span-2 text-[11px] text-muted font-data">
                    {s.lastSyncAt
                      ? `同步于 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`
                      : "尚未同步"}
                    {s.lastError ? ` · ${s.lastError}` : ""}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
