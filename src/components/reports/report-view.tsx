"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatRmb, cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, AlertTriangle, Download } from "lucide-react";
import { ReportTrendChart } from "@/components/reports/report-charts";

interface DailyPoint {
  day: string;
  revenueMeasuredRmb: number;
  grossConsumptionRmb: number;
  revenueRatioRmb: number;
  upstreamCostRmb: number;
  operatingCostRmb: number;
  profitMeasuredRmb: number;
  profitRatioRmb: number;
}

interface ReportPayload {
  period: { kind: string; startDay: string; endDay: string; days: number; label: string };
  usdCny: number;
  revenue: {
    measuredRmb: number;
    ratioRmb: number | null;
    diffRmb: number | null;
    diffPct: number | null;
    midpointRmb: number | null;
    grossConsumptionRmb: number;
    excludedRmb: number;
  };
  cost: {
    upstreamRmb: number;
    operatingRmb: number;
    totalRmb: number;
    source: string;
  };
  profit: {
    measuredRmb: number;
    ratioRmb: number | null;
    measuredMarginPct: number | null;
    ratioMarginPct: number | null;
    spreadRmb: number | null;
  };
  daily: DailyPoint[];
  bySite: {
    id: string;
    name: string;
    enabled: boolean;
    revenueRmb: number;
    grossRmb: number;
    excludedRmb: number;
    requests: number;
    missingDays: number;
    incompleteDays: number;
    excludeResolved: boolean;
  }[];
  byProvider: {
    id: string;
    name: string;
    costRmb: number;
    actualCost: number;
    requests: number;
    source: string;
  }[];
  byKey: {
    providerId: string;
    providerName: string;
    remoteKeyId: string;
    keyName: string;
    upstreamRate: number | null;
    downstreamRate: number | null;
    downstreamSiteName: string | null;
    downstreamGroup: string | null;
    rateSource: string;
    officialBase: number;
    actualCost: number;
    costRmb: number;
    estimatedRevenueRmb: number | null;
    estimatedProfitRmb: number | null;
    marginPct: number | null;
  }[];
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
    selfHostedSellRmb: number;
    selfHostedOfficialCost: number;
    downstreamIssuedRmb: number;
    upstreamRechargePaidRmb: number;
  };
  coverage: {
    measuredComplete: boolean;
    ratioComplete: boolean;
    costComplete: boolean;
    unmappedKeys: number;
    unmappedCostRmb: number;
    billableKeys: number;
    sitesMissingDays: number;
    sitesUnresolvedExclude: number;
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

const RATE_SOURCE_LABEL: Record<string, string> = {
  key: "手工绑定",
  group: "分组同步",
  "site-default": "站点默认",
  none: "未绑定",
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
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
        <div
          className={cn(
            "font-data text-2xl font-semibold tracking-tight",
            tone === "mint" && "text-mint",
            tone === "amber" && "text-amber",
            tone === "coral" && "text-coral",
            tone === "violet" && "text-violet",
            tone === "cyan" && "text-cyan",
          )}
        >
          {value}
        </div>
        {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted">{hint}</p>}
      </CardContent>
    </Card>
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/financial-report?period=${kind}&offset=${offset}`,
        { cache: "no-store" },
      );
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
        body: JSON.stringify({
          startDay: data.period.startDay,
          endDay: data.period.endDay,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "同步失败");
      const ok = (json.data?.results || []).filter(
        (r: { success: boolean }) => r.success,
      ).length;
      setSyncMsg(`已同步 ${ok} 个站点的本周期消费`);
      await load();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  const periodLabel = data?.period.label ?? "";

  return (
    <div className="space-y-6">
      <TopBar
        title="收益报表"
        subtitle="消费收入 − 上游使用成本 − 额外成本 = 服务毛利（充值不计入收入）"
        showSync={false}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(["week", "month"] as const).map((k) => (
            <button
              key={k}
              onClick={() => {
                setKind(k);
                setOffset(0);
              }}
              className={cn(
                "px-3 py-1.5 text-xs transition-colors",
                kind === k
                  ? "bg-cyan/10 text-cyan"
                  : "text-secondary hover:bg-surface-2 hover:text-text",
              )}
            >
              {k === "week" ? "自然周" : "自然月"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="outline"
            onClick={() => setOffset((o) => o - 1)}
            aria-label="上一周期"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[190px] px-2 text-center text-xs font-data text-secondary">
            {periodLabel || "…"}
          </span>
          <Button
            size="icon"
            variant="outline"
            onClick={() => setOffset((o) => Math.min(0, o + 1))}
            disabled={offset >= 0}
            aria-label="下一周期"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        {offset !== 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>
            回到当前
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={syncing} onClick={syncPeriod}>
          <Download className={cn("h-3.5 w-3.5", syncing && "animate-pulse")} />
          {syncing ? "同步中…" : "同步本周期消费"}
        </Button>
        {syncMsg && <span className="text-xs text-secondary font-data">{syncMsg}</span>}
      </div>

      {loading && (
        <div className="flex min-h-[30vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-cyan" />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-xl border border-coral/30 bg-coral/5 p-6 text-sm text-coral">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {data.coverage.warnings.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-amber/30 bg-amber/5 p-4">
              {data.coverage.warnings.map((w) => (
                <div key={w} className="flex items-start gap-2 text-xs text-amber">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="消费收入 · 实测"
              value={formatRmb(data.revenue.measuredRmb)}
              hint={
                data.revenue.excludedRmb > 0
                  ? `付费账号消费 · 已剔除测试号 ${formatRmb(data.revenue.excludedRmb)}`
                  : data.coverage.sitesUnresolvedExclude > 0
                    ? "拿不到逐账号数据，测试号未剔除（偏高）"
                    : data.coverage.measuredComplete
                      ? "付费账号真实消费，数据完整"
                      : "付费账号真实消费，数据不完整"
              }
              tone="violet"
            />
            <Metric
              label="消费收入 · 倍率估算"
              value={
                data.revenue.ratioRmb != null
                  ? formatRmb(data.revenue.ratioRmb)
                  : "—"
              }
              hint={
                data.revenue.diffPct != null
                  ? `与实测差 ${data.revenue.diffPct > 0 ? "+" : ""}${data.revenue.diffPct.toFixed(1)}%`
                  : "需给计费 Key 绑定下游倍率"
              }
              tone="cyan"
            />
            <Metric
              label="总成本"
              value={formatRmb(data.cost.totalRmb)}
              hint={`上游 ${formatRmb(data.cost.upstreamRmb)} · 额外 ${formatRmb(data.cost.operatingRmb)} · ${COST_SOURCE_LABEL[data.cost.source] ?? data.cost.source}`}
              tone="amber"
            />
            <Metric
              label="服务毛利"
              value={formatRmb(data.profit.measuredRmb)}
              hint={
                data.profit.ratioRmb != null
                  ? `倍率法 ${formatRmb(data.profit.ratioRmb)} · 两法差 ${formatRmb(data.profit.spreadRmb ?? 0)}`
                  : data.profit.measuredMarginPct != null
                    ? `毛利率 ${data.profit.measuredMarginPct.toFixed(1)}%`
                    : "收入为 0，无法算毛利率"
              }
              tone={data.profit.measuredRmb >= 0 ? "mint" : "coral"}
            />
          </div>

          <ReportTrendChart data={data.daily} />

          {data.byKey.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                  按计费 Key 估算毛利（倍率法）
                </CardTitle>
                <p className="text-[11px] text-muted">
                  官方基准用量 × 下游卖出倍率 − 上游成本；未绑定倍率的 Key 无法估算
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                      <th className="px-4 py-2">Key</th>
                      <th className="px-4 py-2">下游归属</th>
                      <th className="px-4 py-2 text-right">上游倍率</th>
                      <th className="px-4 py-2 text-right">下游倍率</th>
                      <th className="px-4 py-2 text-right">官方基准</th>
                      <th className="px-4 py-2 text-right">上游成本</th>
                      <th className="px-4 py-2 text-right">估算卖出</th>
                      <th className="px-4 py-2 text-right">估算毛利</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byKey.map((k) => (
                      <tr
                        key={`${k.providerId}-${k.remoteKeyId}`}
                        className="border-b border-border-subtle/60"
                      >
                        <td className="px-4 py-2">
                          <div className="max-w-[180px] truncate font-medium">
                            {k.keyName}
                          </div>
                          <div className="text-[11px] text-muted">{k.providerName}</div>
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {k.downstreamSiteName ? (
                            <div>
                              <div className="truncate max-w-[140px]">
                                {k.downstreamSiteName}
                              </div>
                              <div className="text-[11px] text-muted">
                                {k.downstreamGroup || "—"} ·{" "}
                                {RATE_SOURCE_LABEL[k.rateSource] ?? k.rateSource}
                              </div>
                            </div>
                          ) : (
                            <Badge variant="default">未绑定</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs">
                          {k.upstreamRate != null ? `${k.upstreamRate}x` : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs">
                          {k.downstreamRate != null ? `${k.downstreamRate}x` : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs">
                          {k.officialBase.toFixed(2)}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs text-amber">
                          {formatRmb(k.costRmb)}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs">
                          {k.estimatedRevenueRmb != null
                            ? formatRmb(k.estimatedRevenueRmb)
                            : "—"}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-2 text-right font-data text-xs",
                            (k.estimatedProfitRmb ?? 0) >= 0 ? "text-mint" : "text-coral",
                          )}
                        >
                          {k.estimatedProfitRmb != null
                            ? `${formatRmb(k.estimatedProfitRmb)}${k.marginPct != null ? ` · ${k.marginPct.toFixed(0)}%` : ""}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                  下游消费收入
                </CardTitle>
                <p className="text-[11px] text-muted">
                  收入只算付费账号；测试号消费单列，用来跟上游成本对差值
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {data.bySite.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted">
                    尚未绑定下游站点
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                        <th className="px-4 py-2">站点</th>
                        <th className="px-4 py-2 text-right">收入</th>
                        <th className="px-4 py-2 text-right">测试号</th>
                        <th className="px-4 py-2 text-right">全站消费</th>
                        <th className="px-4 py-2 text-right">缺失</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bySite.map((s) => (
                        <tr key={s.id} className="border-b border-border-subtle/60">
                          <td className="px-4 py-2">
                            <div className="max-w-[140px] truncate">{s.name}</div>
                            <div className="text-[11px] text-muted">
                              {s.enabled ? `${s.requests} 次请求` : "已停用"}
                              {!s.excludeResolved && " · 未拆测试号"}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right font-data text-xs text-mint">
                            {formatRmb(s.revenueRmb)}
                          </td>
                          <td className="px-4 py-2 text-right font-data text-xs text-muted">
                            {s.excludedRmb > 0 ? `−${formatRmb(s.excludedRmb)}` : "—"}
                          </td>
                          <td className="px-4 py-2 text-right font-data text-xs text-secondary">
                            {formatRmb(s.grossRmb)}
                          </td>
                          <td className="px-4 py-2 text-right font-data text-xs">
                            {s.missingDays > 0 ? (
                              <span className="text-amber">{s.missingDays}</span>
                            ) : (
                              <span className="text-muted">0</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                  上游成本
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {data.byProvider.filter((p) => p.costRmb > 0).length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted">
                    本周期没有上游成本记录
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                        <th className="px-4 py-2">上游</th>
                        <th className="px-4 py-2 text-right">成本</th>
                        <th className="px-4 py-2 text-right">面值消耗</th>
                        <th className="px-4 py-2">来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byProvider
                        .filter((p) => p.costRmb > 0)
                        .map((p) => (
                          <tr key={p.id} className="border-b border-border-subtle/60">
                            <td className="px-4 py-2 max-w-[150px] truncate">{p.name}</td>
                            <td className="px-4 py-2 text-right font-data text-xs text-amber">
                              {formatRmb(p.costRmb)}
                            </td>
                            <td className="px-4 py-2 text-right font-data text-xs text-muted">
                              {p.actualCost.toFixed(2)}
                            </td>
                            <td className="px-4 py-2">
                              <Badge
                                variant={p.source === "usage-logs" ? "mint" : "default"}
                              >
                                {COST_SOURCE_LABEL[p.source] ?? p.source}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>

          {data.operatingCosts.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                  额外成本入账
                </CardTitle>
                <p className="text-[11px] text-muted">
                  一次性按记账日整笔计入；期间成本按有效期摊销，提前结束会压缩到实际存活区间
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                      <th className="px-4 py-2">项目</th>
                      <th className="px-4 py-2">模式</th>
                      <th className="px-4 py-2">有效区间</th>
                      <th className="px-4 py-2 text-right">总额</th>
                      <th className="px-4 py-2 text-right">本期入账</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.operatingCosts.map((c) => (
                      <tr key={c.id} className="border-b border-border-subtle/60">
                        <td className="px-4 py-2">
                          <div className="max-w-[200px] truncate">{c.name}</div>
                          <div className="text-[11px] text-muted">{c.category}</div>
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {c.mode === "ONE_TIME" ? (
                            <Badge variant="default">一次性</Badge>
                          ) : c.earlyEnded ? (
                            <Badge variant="coral">提前结束</Badge>
                          ) : c.openEnded ? (
                            <Badge variant="default">进行中</Badge>
                          ) : (
                            <Badge variant="mint">按期摊销</Badge>
                          )}
                        </td>
                        <td className="px-4 py-2 font-data text-[11px] text-muted">
                          {c.mode === "ONE_TIME"
                            ? c.effectiveStartDay
                            : `${c.effectiveStartDay} ~ ${c.effectiveEndDay} · ${c.effectiveDays}天`}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs text-muted">
                          {formatRmb(c.amountRmb)}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-xs text-amber">
                          {formatRmb(c.allocatedRmb)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                差值对账
              </CardTitle>
              <p className="text-[11px] text-muted">
                测试号也烧上游额度但没人付钱：全站消费 − 上游成本 = 整体加价空间，
                跟只算付费账号的毛利分开看
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  全站消费（含测试号）
                </div>
                <div className="font-data text-lg text-secondary">
                  {formatRmb(data.revenue.grossConsumptionRmb)}
                </div>
                <p className="text-[11px] text-muted">对账基数，不是收入</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  其中测试号
                </div>
                <div className="font-data text-lg text-amber">
                  {formatRmb(data.revenue.excludedRmb)}
                </div>
                <p className="text-[11px] text-muted">
                  {data.coverage.sitesUnresolvedExclude > 0
                    ? "有站点拿不到逐账号数据"
                    : "已从收入中剔除"}
                </p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  全站消费 − 上游成本
                </div>
                <div className="font-data text-lg text-cyan">
                  {formatRmb(data.revenue.grossConsumptionRmb - data.cost.upstreamRmb)}
                </div>
                <p className="text-[11px] text-muted">整体加价空间</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  整体加价倍数
                </div>
                <div className="font-data text-lg">
                  {data.cost.upstreamRmb > 0
                    ? `${(data.revenue.grossConsumptionRmb / data.cost.upstreamRmb).toFixed(2)}x`
                    : "—"}
                </div>
                <p className="text-[11px] text-muted">卖出 ÷ 买入</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                参考项（不计入毛利）
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  当前已发放额度
                </div>
                <div className="font-data text-lg">
                  {formatRmb(data.reference.downstreamIssuedRmb)}
                </div>
                <p className="text-[11px] text-muted">存量负债，用户还没消费</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  本期上游充值实付
                </div>
                <div className="font-data text-lg">
                  {formatRmb(data.reference.upstreamRechargePaidRmb)}
                </div>
                <p className="text-[11px] text-muted">现金流，成本按实际消耗入账</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  自建站卖出估算
                </div>
                <div className="font-data text-lg">
                  {formatRmb(data.reference.selfHostedSellRmb)}
                </div>
                <p className="text-[11px] text-muted">中间层估算，避免与下游消费重复</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  自建站官方用量
                </div>
                <div className="font-data text-lg">
                  {data.reference.selfHostedOfficialCost.toFixed(2)}
                </div>
                <p className="text-[11px] text-muted">官方计价面值（美元）</p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
