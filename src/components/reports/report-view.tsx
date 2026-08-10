"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Table, THead, TBody, HeadRow, TH, TR, TD } from "@/components/ui/table";
import { formatRmb, cn } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react";
import { ReportTrendChart } from "@/components/reports/report-charts";
import { OrphanChannelPanel } from "@/components/reports/orphan-channel-panel";

interface DailyPoint {
  day: string;
  revenueMeasuredRmb: number;
  grossConsumptionRmb: number;
  upstreamCostRmb: number;
  operatingCostRmb: number;
  profitMeasuredRmb: number;
}

interface ReportPayload {
  period: { kind: string; startDay: string; endDay: string; days: number; label: string };
  usdCny: number;
  revenue: {
    measuredRmb: number;
    privateRmb: number;
    publicRmb: number;
    grossConsumptionRmb: number;
    excludedRmb: number;
  };
  cost: {
    upstreamRmb: number;
    operatingRmb: number;
    orphanRmb: number;
    totalRmb: number;
    source: string;
  };
  profit: {
    measuredRmb: number;
    measuredMarginPct: number | null;
    privateRmb: number;
    publicRmb: number;
    privateCostRmb: number;
    publicCostRmb: number;
    privateMarginPct: number | null;
    publicMarginPct: number | null;
    privateShare: number;
    allocationSource: "model" | "revenue-share";
    modelAllocatedCostRmb: number;
    fallbackCostRmb: number;
    modelCoveragePct: number;
  };
  prepaid: {
    period: { totalRmb: number; privateRmb: number; publicRmb: number; orders: number };
    month: { totalRmb: number; privateRmb: number; publicRmb: number; orders: number };
    allTime: { totalRmb: number; privateRmb: number; publicRmb: number; orders: number };
    complete: boolean;
    incompleteSites: number;
  };
  daily: DailyPoint[];
  bySite: {
    id: string;
    name: string;
    enabled: boolean;
    revenueRmb: number;
    privateRmb: number;
    publicRmb: number;
    grossRmb: number;
    excludedRmb: number;
    requests: number;
    missingDays: number;
    incompleteDays: number;
    excludeResolved: boolean;
    privateResolved: boolean;
  }[];
  byProvider: {
    id: string;
    name: string;
    costRmb: number;
    actualCost: number;
    requests: number;
    source: string;
  }[];
  byKey: unknown[];
  operatingCosts: {
    id: string;
    name: string;
    category: string;
    mode: string;
    amountRmb: number;
    allocatedRmb: number;
    effectiveStartDay: string;
    effectiveEndDay: string;
    effectiveDays: number;
    overlapDays: number;
    earlyEnded: boolean;
    openEnded: boolean;
  }[];
  reference: {
    selfHostedOfficialCost: number;
    downstreamIssuedRmb: number;
    upstreamRechargePaidRmb: number;
  };
  coverage: {
    measuredComplete: boolean;
    costComplete: boolean;
    billableKeys: number;
    sitesMissingDays: number;
    sitesUnresolvedExclude: number;
    sitesUnresolvedPrivate: number;
    snapshotEstimatedProviderDays: number;
    earlyEndedCostEntries: number;
    openEndedCostEntries: number;
    warnings: string[];
  };
}

const COST_SOURCE_LABEL: Record<string, string> = {
  "usage-logs": "精确日志",
  snapshots: "快照估算",
  mixed: "混合来源",
  none: "无数据",
};

function Metric({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "mint" | "amber" | "coral" | "violet" | "cyan" | "default";
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-xs font-semibold text-secondary">{label}</div>
        <div
          className={cn(
            "mt-1 font-data text-[26px] font-semibold leading-tight text-text",
            tone === "mint" && "text-mint",
            tone === "amber" && "text-cost",
            tone === "coral" && "text-coral",
            tone === "violet" && "text-violet",
            tone === "cyan" && "text-cyan",
          )}
        >
          {value}
        </div>
        {hint && <p className="mt-1.5 text-xs leading-5 text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function BreakdownRow({
  label,
  description,
  revenue,
  cost,
  profit,
  margin,
}: {
  label: string;
  description: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number | null;
}) {
  return (
    <div className="grid gap-3 border-b border-border-subtle py-4 last:border-0 sm:grid-cols-[minmax(150px,1.4fr)_repeat(4,minmax(90px,1fr))] sm:items-center">
      <div>
        <div className="font-medium text-text">{label}</div>
        <p className="text-xs text-muted">{description}</p>
      </div>
      <div><p className="text-[11px] text-muted sm:hidden">收入</p><p className="font-data text-secondary">{formatRmb(revenue)}</p></div>
      <div><p className="text-[11px] text-muted sm:hidden">分摊成本</p><p className="font-data text-cost">{formatRmb(cost)}</p></div>
      <div><p className="text-[11px] text-muted sm:hidden">毛利</p><p className={cn("font-data", profit >= 0 ? "text-mint" : "text-coral")}>{formatRmb(profit)}</p></div>
      <div><p className="text-[11px] text-muted sm:hidden">毛利率</p><p className="font-data text-secondary">{margin == null ? "—" : `${margin.toFixed(1)}%`}</p></div>
    </div>
  );
}

export function ReportView() {
  const [kind, setKind] = useState<"week" | "month">("month");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [detailView, setDetailView] = useState<"income" | "cost">("income");
  const [showWarnings, setShowWarnings] = useState(false);
  const [showPrepaid, setShowPrepaid] = useState(false);
  const [showReconciliation, setShowReconciliation] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/financial-report?period=${kind}&offset=${offset}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [kind, offset]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function syncPeriod() {
    if (!data) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/downstream/usage-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDay: data.period.startDay, endDay: data.period.endDay }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "同步失败");
      const ok = (json.data?.results || []).filter((row: { success: boolean }) => row.success).length;
      setSyncMsg(`已同步 ${ok} 个站点`);
      await load();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  const periodLabel = data?.period.label ?? "";
  const dataComplete = data?.coverage.measuredComplete && data.coverage.costComplete;
  const providerRows = data?.byProvider.filter((provider) => provider.costRmb > 0) ?? [];
  const operatingRows = data?.operatingCosts.filter((cost) => cost.allocatedRmb !== 0) ?? [];

  return (
    <div className="space-y-6">
      <TopBar
        title="收益报表"
        subtitle="先看收入、成本和毛利；对账与维护信息按需展开"
        showSync={false}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="统计周期"
          value={kind}
          onChange={(next) => { setKind(next); setOffset(0); }}
          options={[{ value: "week", label: "自然周" }, { value: "month", label: "自然月" }]}
        />
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" onClick={() => setOffset((value) => value - 1)} aria-label="上一周期">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[190px] px-2 text-center text-xs font-data text-secondary">{periodLabel || "…"}</span>
          <Button size="icon" variant="outline" onClick={() => setOffset((value) => Math.min(0, value + 1))} disabled={offset >= 0} aria-label="下一周期">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        {offset !== 0 && <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>回到当前</Button>}
        <Button size="sm" variant="secondary" disabled={syncing} onClick={syncPeriod}>
          <Download className={cn("h-3.5 w-3.5", syncing && "animate-pulse")} />
          {syncing ? "同步中…" : "同步本周期消费"}
        </Button>
        {syncMsg && <span className="text-xs font-data text-secondary">{syncMsg}</span>}
      </div>

      {loading && (
        <div className="space-y-4" role="status" aria-live="polite">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-32 animate-pulse rounded-[var(--r-lg)] border border-border-subtle bg-surface-2" />)}
          </div>
          <div className="h-80 animate-pulse rounded-[var(--r-lg)] border border-border-subtle bg-surface-2" />
          <span className="sr-only">正在加载收益报表</span>
        </div>
      )}

      {error && !loading && <Callout tone="error" role="alert">{error}</Callout>}

      {data && !loading && (
        <>
          <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-md)] border px-4 py-3", dataComplete ? "border-mint/25 bg-mint/5" : "border-warn/30 bg-tint-warn")}>
            <div className="flex items-center gap-2 text-sm">
              {!dataComplete && <AlertTriangle className="h-4 w-4 text-warn" />}
              <span className={dataComplete ? "text-mint" : "text-text"}>
                {dataComplete ? "本周期数据完整" : data.coverage.warnings[0] || "本周期数据不完整"}
              </span>
            </div>
            {data.coverage.warnings.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowWarnings((value) => !value)} aria-expanded={showWarnings}>
                {showWarnings ? "收起" : `查看 ${data.coverage.warnings.length} 条说明`}
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showWarnings && "rotate-180")} />
              </Button>
            )}
          </div>

          {showWarnings && data.coverage.warnings.length > 0 && (
            <Callout tone="warn" icon={false} role="status">
              <div className="space-y-1.5">
                {data.coverage.warnings.map((warning) => <div key={warning}>{warning}</div>)}
              </div>
            </Callout>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="付费消费收入" value={formatRmb(data.revenue.measuredRmb)} hint="已剔除测试账号消费" tone="violet" />
            <Metric label="上游成本" value={formatRmb(data.cost.upstreamRmb)} hint={COST_SOURCE_LABEL[data.cost.source] ?? data.cost.source} tone="amber" />
            <Metric label="额外成本" value={formatRmb(data.cost.operatingRmb)} hint={data.cost.orphanRmb > 0 ? `含旧渠道补录 ${formatRmb(data.cost.orphanRmb)}` : "采购、订阅及其他运营成本"} tone="amber" />
            <Metric label="服务毛利" value={formatRmb(data.profit.measuredRmb)} hint={data.profit.measuredMarginPct == null ? "本期无收入" : `毛利率 ${data.profit.measuredMarginPct.toFixed(1)}%`} tone={data.profit.measuredRmb >= 0 ? "mint" : "coral"} />
          </div>

          <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-2 px-4 py-3 text-center text-sm text-secondary">
            <span className="font-data text-violet">{formatRmb(data.revenue.measuredRmb)}</span>
            <span className="mx-2 text-muted">−</span>
            <span className="font-data text-cost">{formatRmb(data.cost.upstreamRmb)}</span>
            <span className="mx-2 text-muted">−</span>
            <span className="font-data text-cost">{formatRmb(data.cost.operatingRmb)}</span>
            <span className="mx-2 text-muted">=</span>
            <span className={cn("font-data font-semibold", data.profit.measuredRmb >= 0 ? "text-mint" : "text-coral")}>{formatRmb(data.profit.measuredRmb)}</span>
          </div>

          <ReportTrendChart data={data.daily} />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">收入与毛利构成</CardTitle>
              <p className="text-xs text-muted">成本优先按模型对齐，无法对齐的部分按收入占比分摊</p>
            </CardHeader>
            <CardContent>
              <div className="hidden grid-cols-[minmax(150px,1.4fr)_repeat(4,minmax(90px,1fr))] gap-3 border-b border-border-subtle pb-2 text-[11px] text-muted sm:grid">
                <span>来源</span><span>收入</span><span>分摊成本</span><span>毛利</span><span>毛利率</span>
              </div>
              <BreakdownRow label="私域" description="自己推广的付费用户" revenue={data.revenue.privateRmb} cost={data.profit.privateCostRmb} profit={data.profit.privateRmb} margin={data.profit.privateMarginPct} />
              <BreakdownRow label="公共池" description="其他渠道的付费用户" revenue={data.revenue.publicRmb} cost={data.profit.publicCostRmb} profit={data.profit.publicRmb} margin={data.profit.publicMarginPct} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
              <div>
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">用户预收款</CardTitle>
                <p className="text-xs text-muted">现金流参考，不计入服务毛利</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setShowPrepaid((value) => !value)} aria-expanded={showPrepaid}>
                {showPrepaid ? "收起" : "查看历史"}
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showPrepaid && "rotate-180")} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div><p className="text-xs text-muted">本月合计</p><p className="font-data text-xl text-mint">{formatRmb(data.prepaid.month.totalRmb)}</p><p className="text-[11px] text-muted">{data.prepaid.month.orders} 笔成功充值</p></div>
                <div><p className="text-xs text-muted">本月私域</p><p className="font-data text-xl text-cyan">{formatRmb(data.prepaid.month.privateRmb)}</p></div>
                <div><p className="text-xs text-muted">本月公共池</p><p className="font-data text-xl text-violet">{formatRmb(data.prepaid.month.publicRmb)}</p></div>
              </div>
              {showPrepaid && (
                <div className="grid gap-4 border-t border-border-subtle pt-4 text-sm sm:grid-cols-2">
                  <div><p className="text-xs text-muted">历史累计</p><p className="font-data text-lg">{formatRmb(data.prepaid.allTime.totalRmb)}</p><p className="text-[11px] text-muted">私域 {formatRmb(data.prepaid.allTime.privateRmb)} · 公共 {formatRmb(data.prepaid.allTime.publicRmb)}</p></div>
                  <div><p className="text-xs text-muted">所选周期</p><p className="font-data text-lg">{formatRmb(data.prepaid.period.totalRmb)}</p><p className="text-[11px] text-muted">{data.prepaid.period.orders} 笔 · 私域 {formatRmb(data.prepaid.period.privateRmb)} · 公共 {formatRmb(data.prepaid.period.publicRmb)}</p></div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
              <div>
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">收支明细</CardTitle>
                <p className="text-xs text-muted">只保留影响本期收入和成本的项目</p>
              </div>
              <Segmented ariaLabel="收支明细类型" value={detailView} onChange={setDetailView} options={[{ value: "income", label: "收入" }, { value: "cost", label: "成本" }]} />
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {detailView === "income" ? (
                data.bySite.length === 0 ? <div className="py-8 text-center text-sm text-muted">本周期没有下游收入</div> : (
                  <Table>
                    <THead><HeadRow><TH>站点</TH><TH className="text-right">付费收入</TH><TH className="text-right">私域</TH><TH className="text-right">公共</TH><TH>状态</TH></HeadRow></THead>
                    <TBody>{data.bySite.map((site) => (
                      <TR key={site.id}>
                        <TD><div className="max-w-[180px] truncate font-medium">{site.name}</div><div className="text-[11px] text-muted">{site.requests} 次请求</div></TD>
                        <TD className="text-right font-data text-xs text-mint">{formatRmb(site.revenueRmb)}</TD>
                        <TD className="text-right font-data text-xs text-cyan">{formatRmb(site.privateRmb)}</TD>
                        <TD className="text-right font-data text-xs text-violet">{formatRmb(site.publicRmb)}</TD>
                        <TD><div className="flex flex-wrap gap-1">{site.missingDays > 0 && <Badge variant="amber">缺 {site.missingDays} 天</Badge>}{!site.excludeResolved && <Badge variant="amber">测试号未拆</Badge>}{!site.privateResolved && <Badge variant="default">私域未拆</Badge>}{site.missingDays === 0 && site.excludeResolved && site.privateResolved && <Badge variant="mint">完整</Badge>}</div></TD>
                      </TR>
                    ))}</TBody>
                  </Table>
                )
              ) : providerRows.length === 0 ? <div className="py-8 text-center text-sm text-muted">本周期没有上游成本</div> : (
                <Table>
                  <THead><HeadRow><TH>上游</TH><TH className="text-right">本期成本</TH><TH className="text-right">面值消耗</TH><TH>数据来源</TH></HeadRow></THead>
                  <TBody>{providerRows.map((provider) => (
                    <TR key={provider.id}>
                      <TD className="max-w-[200px] truncate font-medium">{provider.name}</TD>
                      <TD className="text-right font-data text-xs text-cost">{formatRmb(provider.costRmb)}</TD>
                      <TD className="text-right font-data text-xs text-muted">{provider.actualCost.toFixed(2)}</TD>
                      <TD><Badge variant={provider.source === "usage-logs" ? "mint" : "default"}>{COST_SOURCE_LABEL[provider.source] ?? provider.source}</Badge></TD>
                    </TR>
                  ))}</TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {operatingRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">额外成本明细</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <THead><HeadRow><TH>项目</TH><TH>有效期</TH><TH className="text-right">本期入账</TH></HeadRow></THead>
                  <TBody>{operatingRows.map((cost) => (
                    <TR key={cost.id}>
                      <TD><div className="max-w-[220px] truncate font-medium">{cost.name}</div><div className="text-[11px] text-muted">{cost.category} · {cost.mode === "ONE_TIME" ? "一次性" : cost.earlyEnded ? "提前结束" : "按期摊销"}</div></TD>
                      <TD className="font-data text-[11px] text-muted">{cost.mode === "ONE_TIME" ? cost.effectiveStartDay : `${cost.effectiveStartDay} ~ ${cost.effectiveEndDay}`}</TD>
                      <TD className="text-right font-data text-xs text-cost">{formatRmb(cost.allocatedRmb)}</TD>
                    </TR>
                  ))}</TBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <OrphanChannelPanel period={{ startDay: data.period.startDay, endDay: data.period.endDay }} onChanged={load} />

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
              <div>
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">对账与数据质量</CardTitle>
                <p className="text-xs text-muted">这些数字不参与服务毛利，仅用于核对和排查</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setShowReconciliation((value) => !value)} aria-expanded={showReconciliation}>
                {showReconciliation ? "收起" : "展开"}
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showReconciliation && "rotate-180")} />
              </Button>
            </CardHeader>
            {showReconciliation && (
              <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div><p className="text-xs text-muted">全站消费（含测试号）</p><p className="font-data text-lg">{formatRmb(data.revenue.grossConsumptionRmb)}</p></div>
                <div><p className="text-xs text-muted">测试号消费</p><p className="font-data text-lg text-amber">{formatRmb(data.revenue.excludedRmb)}</p></div>
                <div><p className="text-xs text-muted">全站消费减上游成本</p><p className="font-data text-lg text-cyan">{formatRmb(data.revenue.grossConsumptionRmb - data.cost.upstreamRmb)}</p></div>
                <div><p className="text-xs text-muted">当前已发放额度</p><p className="font-data text-lg">{formatRmb(data.reference.downstreamIssuedRmb)}</p></div>
                <div><p className="text-xs text-muted">本期上游充值实付</p><p className="font-data text-lg">{formatRmb(data.reference.upstreamRechargePaidRmb)}</p></div>
                <div><p className="text-xs text-muted">自建站官方用量</p><p className="font-data text-lg">{data.reference.selfHostedOfficialCost.toFixed(2)}</p></div>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
