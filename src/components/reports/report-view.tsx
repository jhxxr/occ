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
import { ChevronLeft, ChevronRight, AlertTriangle, Download } from "lucide-react";
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
    officialBase: number;
    actualCost: number;
    costRmb: number;
    requests: number;
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
    <Card className="transition-shadow duration-200 hover:shadow-lg">
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
        <Segmented
          ariaLabel="统计周期"
          value={kind}
          onChange={(next) => {
            setKind(next);
            setOffset(0);
          }}
          options={[
            { value: "week", label: "自然周" },
            { value: "month", label: "自然月" },
          ]}
        />
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
        <div className="space-y-4" role="status" aria-live="polite">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-32 animate-pulse rounded-[var(--r-lg)] border border-border-subtle bg-surface-2"
              />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-[var(--r-lg)] border border-border-subtle bg-surface-2" />
          <span className="sr-only">正在加载收益报表</span>
        </div>
      )}

      {error && !loading && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}

      {data && !loading && (
        <>
          {data.coverage.warnings.length > 0 && (
            <Callout tone="warn" icon={false} role="status">
              <div className="space-y-1.5">
                {data.coverage.warnings.map((w) => (
                  <div key={w} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            </Callout>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="服务毛利"
              value={formatRmb(data.profit.measuredRmb)}
              hint={
                data.profit.measuredMarginPct != null
                  ? `毛利率 ${data.profit.measuredMarginPct.toFixed(1)}%`
                  : "收入为 0，无法算毛利率"
              }
              tone={data.profit.measuredRmb >= 0 ? "mint" : "coral"}
            />
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
              label="总成本"
              value={formatRmb(data.cost.totalRmb)}
              hint={`上游 ${formatRmb(data.cost.upstreamRmb)} · 额外 ${formatRmb(data.cost.operatingRmb)}${data.cost.orphanRmb > 0 ? ` · 旧渠道 ${formatRmb(data.cost.orphanRmb)}` : ""} · ${COST_SOURCE_LABEL[data.cost.source] ?? data.cost.source}`}
              tone="amber"
            />
            <Metric
              label="全站消费"
              value={formatRmb(data.revenue.grossConsumptionRmb)}
              hint="含测试号，用来跟上游成本对差值"
              tone="cyan"
            />
          </div>

          <ReportTrendChart data={data.daily} />

          <OrphanChannelPanel
            period={{ startDay: data.period.startDay, endDay: data.period.endDay }}
            onChanged={load}
          />

          {data.byKey.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
                  按计费 Key 的上游成本
                </CardTitle>
                <p className="text-[11px] text-muted">
                  当日实扣 × 当日购入成本率，成本率写入即冻结 · 官方基准来自明细快照
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <THead>
                    <HeadRow>
                      <TH>Key</TH>
                      <TH className="text-right">上游倍率</TH>
                      <TH className="text-right">官方基准</TH>
                      <TH className="text-right">实扣面值</TH>
                      <TH className="text-right">请求</TH>
                      <TH className="text-right">上游成本</TH>
                    </HeadRow>
                  </THead>
                  <TBody>
                    {data.byKey.map((k) => (
                      <TR key={`${k.providerId}-${k.remoteKeyId}`}>
                        <TD>
                          <div className="max-w-[200px] truncate font-medium">
                            {k.keyName}
                          </div>
                          <div className="text-[11px] text-muted">{k.providerName}</div>
                        </TD>
                        <TD className="text-right font-data text-xs text-muted">
                          {k.upstreamRate != null ? `${k.upstreamRate}x` : "—"}
                        </TD>
                        <TD className="text-right font-data text-xs">
                          {k.officialBase > 0 ? k.officialBase.toFixed(2) : "—"}
                        </TD>
                        <TD className="text-right font-data text-xs">
                          {k.actualCost > 0 ? k.actualCost.toFixed(4) : "—"}
                        </TD>
                        <TD className="text-right font-data text-xs text-muted">
                          {k.requests || "—"}
                        </TD>
                        <TD className="text-right font-data text-xs text-cost">
                          {formatRmb(k.costRmb)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
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
                  <Table>
                    <THead>
                      <HeadRow>
                        <TH>站点</TH>
                        <TH className="text-right">收入</TH>
                        <TH className="text-right">测试号</TH>
                        <TH className="text-right">全站消费</TH>
                        <TH className="text-right">缺失</TH>
                      </HeadRow>
                    </THead>
                    <TBody>
                      {data.bySite.map((s) => (
                        <TR key={s.id}>
                          <TD>
                            <div className="max-w-[140px] truncate">{s.name}</div>
                            <div className="text-[11px] text-muted">
                              {s.enabled ? `${s.requests} 次请求` : "已停用"}
                              {!s.excludeResolved && " · 未拆测试号"}
                            </div>
                          </TD>
                          <TD className="text-right font-data text-xs text-mint">
                            {formatRmb(s.revenueRmb)}
                          </TD>
                          <TD className="text-right font-data text-xs text-muted">
                            {s.excludedRmb > 0 ? `−${formatRmb(s.excludedRmb)}` : "—"}
                          </TD>
                          <TD className="text-right font-data text-xs text-secondary">
                            {formatRmb(s.grossRmb)}
                          </TD>
                          <TD className="text-right font-data text-xs">
                            {s.missingDays > 0 ? (
                              <span className="text-amber">{s.missingDays}</span>
                            ) : (
                              <span className="text-muted">0</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
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
                  <Table>
                    <THead>
                      <HeadRow>
                        <TH>上游</TH>
                        <TH className="text-right">成本</TH>
                        <TH className="text-right">面值消耗</TH>
                        <TH>来源</TH>
                      </HeadRow>
                    </THead>
                    <TBody>
                      {data.byProvider
                        .filter((p) => p.costRmb > 0)
                        .map((p) => (
                          <TR key={p.id}>
                            <TD className="max-w-[150px] truncate">{p.name}</TD>
                            <TD className="text-right font-data text-xs text-cost">
                              {formatRmb(p.costRmb)}
                            </TD>
                            <TD className="text-right font-data text-xs text-muted">
                              {p.actualCost.toFixed(2)}
                            </TD>
                            <TD>
                              <Badge
                                variant={p.source === "usage-logs" ? "mint" : "default"}
                              >
                                {COST_SOURCE_LABEL[p.source] ?? p.source}
                              </Badge>
                            </TD>
                          </TR>
                        ))}
                    </TBody>
                  </Table>
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
                <Table>
                  <THead>
                    <HeadRow>
                      <TH>项目</TH>
                      <TH>模式</TH>
                      <TH>有效区间</TH>
                      <TH className="text-right">总额</TH>
                      <TH className="text-right">本期入账</TH>
                    </HeadRow>
                  </THead>
                  <TBody>
                    {data.operatingCosts.map((c) => (
                      <TR key={c.id}>
                        <TD>
                          <div className="max-w-[200px] truncate">{c.name}</div>
                          <div className="text-[11px] text-muted">{c.category}</div>
                        </TD>
                        <TD className="text-xs">
                          {c.mode === "ONE_TIME" ? (
                            <Badge variant="default">一次性</Badge>
                          ) : c.earlyEnded ? (
                            <Badge variant="coral">提前结束</Badge>
                          ) : c.openEnded ? (
                            <Badge variant="default">进行中</Badge>
                          ) : (
                            <Badge variant="mint">按期摊销</Badge>
                          )}
                        </TD>
                        <TD className="font-data text-[11px] text-muted">
                          {c.mode === "ONE_TIME"
                            ? c.effectiveStartDay
                            : `${c.effectiveStartDay} ~ ${c.effectiveEndDay} · ${c.effectiveDays}天`}
                        </TD>
                        <TD className="text-right font-data text-xs text-muted">
                          {formatRmb(c.amountRmb)}
                        </TD>
                        <TD className="text-right font-data text-xs text-cost">
                          {formatRmb(c.allocatedRmb)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
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
