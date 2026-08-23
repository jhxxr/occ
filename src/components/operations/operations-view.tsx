"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, Search } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { BusinessOverview } from "@/components/operations/business-overview";
import { ChannelOperationsTable } from "@/components/operations/channel-operations-table";
import { OptimizationQueue } from "@/components/operations/optimization-queue";
import { ChannelCreateDialog } from "@/components/operations/channel-create-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { OperationsChannel, OperationsPayload } from "@/lib/operations";
import type { OptimizationAction } from "@/lib/channel-scheduler";
import { formatRmb, cn } from "@/lib/utils";
import { errorOf, readJson } from "@/lib/sync-client";

export function OperationsView() {
  const searchParams = useSearchParams();
  const initialSite = searchParams.get("siteId") || "all";
  const initialChannel = Number(searchParams.get("channelId"));
  const [data, setData] = useState<OperationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteId, setSiteId] = useState(initialSite);
  const [health, setHealth] = useState("all");
  const [cost, setCost] = useState("all");
  const [suggestionsOnly, setSuggestionsOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(initialChannel > 0 && initialSite !== "all" ? `${initialSite}:${initialChannel}` : null);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/operations", { cache: "no-store" });
      const json = await readJson(response);
      if (!response.ok) throw new Error(errorOf(json, `HTTP ${response.status}`));
      if (!json.data) throw new Error("空响应");
      setData(json.data as OperationsPayload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载运营控制台失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.channels.filter((channel) => {
      if (siteId !== "all" && channel.siteId !== siteId) return false;
      if (health !== "all" && channel.health !== health) return false;
      if (cost === "known" && channel.rateMultiplier == null) return false;
      if (cost === "unknown" && channel.rateMultiplier != null) return false;
      if (suggestionsOnly && channel.actionIds.length === 0) return false;
      if (!q) return true;
      return [channel.name, channel.siteName, channel.group, String(channel.channelId), channel.providerName || "", channel.models.join(" ")].join(" ").toLowerCase().includes(q);
    });
  }, [cost, data, health, query, siteId, suggestionsOnly]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => channelScore(b, data?.actions || []) - channelScore(a, data?.actions || []) || b.requests24h - a.requests24h), [data, filtered]);
  const openAction = (action: OptimizationAction) => { setSiteId(action.siteId); setSuggestionsOnly(false); setOpenKey(`${action.siteId}:${action.channelId}`); document.getElementById("channel-matrix")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const toggle = (channel: OperationsChannel) => setOpenKey((current) => current === `${channel.siteId}:${channel.channelId}` ? null : `${channel.siteId}:${channel.channelId}`);

  if (loading && !data) return <div className="flex justify-center py-32"><Spinner label="聚合全局经营数据" /></div>;
  if (error && !data) return <Callout tone="error" title="运营控制台加载失败">{error}</Callout>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <TopBar title="全局运营控制台" subtitle="把资金、成本、毛利、渠道健康和调度建议放在同一条决策链上" showSync={false} statusLine={<span className="text-xs text-muted">{data.period.label} · 更新 {new Date(data.fetchedAt).toLocaleString("zh-CN")}</span>} />
      {error && <Callout tone="error">{error}</Callout>}
      {data.coverage.warnings.length > 0 && <Callout tone="warn" title={`${data.coverage.warnings.length} 条数据与运营提醒`}><ul className="space-y-1">{data.coverage.warnings.slice(0, 4).map((warning) => <li key={warning}>· {warning}</li>)}</ul></Callout>}
      <BusinessOverview data={data} />
      <section className="grid gap-4 xl:grid-cols-2">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">上游资金池</CardTitle><p className="text-xs text-muted">余额按购入成本折算；本月成本使用历史冻结口径。</p></CardHeader><CardContent className="space-y-2">{data.providers.map((provider) => <div key={provider.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2.5"><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-xs font-medium text-text">{provider.name}</span>{provider.lowBalance && <Badge variant="coral">低余额</Badge>}</div><p className="mt-0.5 text-[10px] text-muted">本月成本 {formatRmb(provider.monthCostRmb)}{provider.costSharePct == null ? "" : ` · 占 ${provider.costSharePct.toFixed(1)}%`}</p></div><div className={cn("shrink-0 font-data text-sm", provider.lowBalance ? "text-coral" : "text-cyan")}>{provider.balanceRmb == null ? "未同步" : formatRmb(provider.balanceRmb)}</div></div>)}</CardContent></Card>
        <OptimizationQueue actions={data.actions} onOpen={openAction} />
      </section>
      <section id="channel-matrix" className="scroll-mt-4 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-base font-semibold text-text">渠道经营矩阵</h2><p className="mt-1 text-xs text-muted">渠道消耗是下游日志面值；当前倍率仅用于现在的调度判断，不是历史毛利。</p></div><div className="flex items-center gap-2"><ChannelCreateDialog siteId={siteId === "all" ? data.sites[0]?.id || "" : siteId} onCreated={() => void load(true)} /><Button size="sm" variant="secondary" disabled={refreshing} onClick={() => void load(true)}><RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />{refreshing ? "聚合中…" : "刷新全部"}</Button></div></div>
        <div className="flex flex-wrap gap-2 rounded-[var(--r-lg)] border border-border-subtle bg-surface p-3"><Select className="h-9 w-auto min-w-32" value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="站点筛选"><option value="all">全部站点</option>{data.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</Select><Select className="h-9 w-auto min-w-28" value={health} onChange={(e) => setHealth(e.target.value)} aria-label="健康筛选"><option value="all">全部状态</option><option value="critical">严重</option><option value="degraded">降级</option><option value="healthy">正常</option><option value="silent">静默</option><option value="idle">闲置</option><option value="disabled">禁用</option></Select><Select className="h-9 w-auto min-w-28" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="成本筛选"><option value="all">全部成本</option><option value="known">成本已知</option><option value="unknown">成本未知</option></Select><Button size="sm" variant={suggestionsOnly ? "default" : "ghost"} onClick={() => setSuggestionsOnly((value) => !value)}>只看有建议</Button><div className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" /><Input className="h-9 pl-9" placeholder="搜渠道 / 分组 / 上游 / 模型" value={query} onChange={(e) => setQuery(e.target.value)} /></div><span className="self-center text-xs text-muted">{sorted.length} / {data.channels.length}</span></div>
        <ChannelOperationsTable channels={sorted} actions={data.actions} openKey={openKey} onToggle={toggle} />
      </section>
    </div>
  );
}

function channelScore(channel: OperationsChannel, actions: OptimizationAction[]) { const severity: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }; return channel.actionIds.reduce((score, id) => Math.max(score, severity[actions.find((item) => item.id === id)?.severity || ""] || 0), 0) * 1_000_000 + channel.requests24h; }
