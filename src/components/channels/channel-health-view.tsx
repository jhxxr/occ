"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { Input, Select } from "@/components/ui/input";
import {
  Table,
  TableWrap,
  THead,
  TBody,
  HeadRow,
  TH,
  TR,
  TD,
} from "@/components/ui/table";
import { cn, formatCompact } from "@/lib/utils";
import { errorOf, readJson } from "@/lib/sync-client";
import {
  Activity,
  AlertTriangle,
  Clock3,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  ChannelHealthDetail,
  ChannelHealthLevel,
  ChannelHealthPayload,
  ChannelHealthRow,
} from "@/lib/channel-health";
import {
  formatAgo,
  formatIssuePct,
  formatMs,
  formatPct,
  formatSec,
  formatTime,
  KumaHeartbeat,
  KumaMonitorRow,
  KumaOverallBanner,
  KumaPanel,
  KumaStatusPill,
  KumaToolbar,
  levelColor,
  uptimeColor,
} from "@/components/channels/uptime-shared";

type FilterKey = "all" | "up" | "down" | "maintenance" | ChannelHealthLevel;

const FILTERS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "down", label: "异常" },
  { value: "up", label: "正常" },
  { value: "maintenance", label: "维护/闲置" },
  { value: "critical", label: "严重" },
  { value: "degraded", label: "降级" },
  { value: "silent", label: "静默" },
];

function matchesFilter(row: ChannelHealthRow, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "up") return row.health === "healthy";
  if (filter === "down") {
    return row.health === "critical" || row.health === "degraded";
  }
  if (filter === "maintenance") {
    return row.health === "disabled" || row.health === "idle";
  }
  return row.health === filter;
}

export function ChannelHealthView() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<ChannelHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [siteId, setSiteId] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChannelHealthDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const qSite = searchParams.get("siteId");
    const qGroup = searchParams.get("group");
    if (qSite) setSiteId(qSite);
    if (qGroup != null) setGroupFilter(qGroup);
  }, [searchParams]);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/channel-health", { cache: "no-store" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(errorOf(json, `HTTP ${res.status}`));
      const payload = json.data as ChannelHealthPayload | undefined;
      if (!payload) throw new Error("空响应");
      setData(payload);
      setNowMs(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 60_000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const openDetail = useCallback(async (row: ChannelHealthRow) => {
    const key = `${row.siteId}:${row.channelId}`;
    setDetailKey(key);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetch(
        `/api/channel-health/detail?siteId=${encodeURIComponent(row.siteId)}&channelId=${row.channelId}`,
        { cache: "no-store" },
      );
      const json = await readJson(res);
      if (!res.ok) throw new Error(errorOf(json, `HTTP ${res.status}`));
      const payload = json.data as ChannelHealthDetail | undefined;
      if (!payload) throw new Error("空响应");
      setDetail(payload);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetailKey(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  useEffect(() => {
    if (!detailKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailKey, closeDetail]);

  const siteOptions = useMemo(() => {
    const sites = data?.sites || [];
    return [
      { id: "all", name: "全部站点" },
      ...sites.map((s) => ({ id: s.siteId, name: s.siteName })),
    ];
  }, [data]);

  const filtered = useMemo(() => {
    let rows = data?.channels || [];
    if (siteId !== "all") rows = rows.filter((r) => r.siteId === siteId);
    if (groupFilter != null) {
      rows = rows.filter((r) => (r.group || "") === groupFilter);
    }
    rows = rows.filter((r) => matchesFilter(r, filter));
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => {
        const hay = [
          r.name,
          r.group,
          r.tag,
          String(r.channelId),
          r.models.join(" "),
          r.reasons.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return rows;
  }, [data, siteId, groupFilter, filter, query]);

  const summary = useMemo(() => {
    if (!data) return null;
    if (siteId === "all" && groupFilter == null) return data.summary;
    // 当前视图重算
    let req = 0;
    let ok = 0;
    let down = 0;
    let monitored = 0;
    let critical = 0;
    let degraded = 0;
    let silent = 0;
    let healthy = 0;
    let idle = 0;
    let disabled = 0;
    for (const r of filtered) {
      if (r.health === "critical") {
        critical++;
        down++;
      } else if (r.health === "degraded") {
        degraded++;
        down++;
      } else if (r.health === "silent") silent++;
      else if (r.health === "healthy") healthy++;
      else if (r.health === "idle") idle++;
      else if (r.health === "disabled") disabled++;
      if (r.health !== "disabled" && r.health !== "idle") {
        monitored++;
        if (r.d1.requests > 0) {
          req += r.d1.requests;
          ok += Math.max(0, r.d1.requests - r.d1.issues);
        }
      }
    }
    return {
      ...data.summary,
      critical,
      degraded,
      silent,
      healthy,
      idle,
      disabled,
      downCount: down,
      upCount: healthy,
      monitoredCount: monitored,
      uptime24h: req > 0 ? Math.round((ok / req) * 10000) / 100 : null,
      total: filtered.length,
    };
  }, [data, siteId, groupFilter, filtered]);

  const unbound = (data?.sites || []).filter((s) => !s.dbBound);
  const failed = (data?.sites || []).filter((s) => s.dbBound && !s.ok);
  const multiSite = (data?.sites.length || 0) > 1;

  const banner = useMemo(() => {
    if (!summary) {
      return {
        title: "加载中",
        subtitle: "",
        tone: "idle" as const,
        uptime: null as number | null,
      };
    }
    const hasDown = summary.downCount > 0;
    const monitored = summary.monitoredCount;
    const allUp = monitored > 0 && !hasDown;
    const hasSilentOnly = allUp && summary.silent > 0;
    return {
      title: hasDown
        ? `${summary.downCount} 个渠道异常`
        : hasSilentOnly
          ? "运行正常"
          : allUp
            ? "All Systems Operational"
            : monitored === 0
              ? "暂无监控中的渠道"
              : "部分维护中",
      subtitle: `监控 ${monitored} · Up ${summary.upCount} · 异常 ${summary.downCount} · 静默 ${summary.silent} · 维护/闲置 ${summary.disabled + summary.idle}`,
      tone: hasDown
        ? ("down" as const)
        : allUp
          ? ("up" as const)
          : ("idle" as const),
      uptime: summary.uptime24h,
    };
  }, [summary]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <TopBar
        title="渠道健康"
        subtitle="Kuma 风格状态页 · 下游 NewAPI 渠道"
        showSync={false}
        statusLine={
          data ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  autoRefresh ? "animate-pulse bg-mint" : "bg-muted",
                )}
              />
              {autoRefresh ? "60s 自动刷新" : "手动刷新"}
              <span className="text-border">·</span>
              {formatTime(data.fetchedAt)}
            </span>
          ) : null
        }
      />

      {groupFilter != null && (
        <Callout tone="info" title="已按分组筛选">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              分组：
              <span className="font-medium text-text">
                {groupFilter.trim() || "未分组"}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setGroupFilter(null)}
            >
              清除
            </Button>
            <Link
              href="/groups"
              className="text-xs font-medium text-accent hover:underline"
            >
              返回分组 Uptime
            </Link>
          </div>
        </Callout>
      )}

      <KumaToolbar>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
            />
            刷新
          </Button>
          <Button
            type="button"
            variant={autoRefresh ? "default" : "ghost"}
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            <Activity className="h-3.5 w-3.5" />
            {autoRefresh ? "Auto" : "手动"}
          </Button>
          <Select
            className="h-9 w-auto min-w-[9rem] rounded-full border-border-subtle bg-surface-2 px-3.5 text-xs font-medium"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            aria-label="按站点筛选"
          >
            {siteOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Link
            href="/groups"
            className="inline-flex h-9 items-center rounded-full px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-2 hover:text-text"
          >
            分组视图
          </Link>
        </div>
        <div className="relative min-w-0 flex-1 sm:max-w-xs sm:flex-none">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜渠道名 / 分组 / 模型"
            className="h-9 rounded-full border-border-subtle bg-surface-2 pl-9 text-xs"
          />
        </div>
      </KumaToolbar>

      {error && (
        <Callout tone="error" title="加载失败">
          {error}
        </Callout>
      )}
      {unbound.length > 0 && (
        <Callout tone="warn" title="部分站点未绑定数据库">
          {unbound.map((s) => s.siteName).join("、")} 需要在「下游」页粘贴只读
          SQL_DSN。
        </Callout>
      )}
      {failed.map((s) => (
        <Callout key={s.siteId} tone="error" title={`${s.siteName} 读取失败`}>
          {s.error || "未知错误"}
        </Callout>
      ))}

      {loading && !data ? (
        <KumaPanel className="flex items-center justify-center py-24">
          <Spinner label="加载渠道健康" />
        </KumaPanel>
      ) : (
        <>
          <KumaOverallBanner
            title={banner.title}
            subtitle={banner.subtitle}
            tone={banner.tone}
            uptime={banner.uptime}
          />

          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <Segmented
              ariaLabel="状态筛选"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={FILTERS}
            />
            <div className="text-xs text-muted">
              <span className="font-data font-medium text-secondary">
                {filtered.length}
              </span>{" "}
              个监控
            </div>
          </div>

          {filtered.length === 0 ? (
            <KumaPanel className="px-5 py-16 text-center">
              <p className="text-sm font-medium text-secondary">
                {data && data.channels.length === 0
                  ? "还没有可监控的渠道"
                  : "当前筛选下没有渠道"}
              </p>
              <p className="mt-1 text-xs text-muted">
                {data && data.channels.length === 0
                  ? "请先在下游站点绑定只读数据库。"
                  : "试试切换筛选或清空搜索。"}
              </p>
            </KumaPanel>
          ) : (
            <KumaPanel>
              {filtered.map((row) => {
                const avg = row.h1.avgUseTimeSec ?? row.d1.avgUseTimeSec;
                const ping =
                  row.responseTimeMs != null
                    ? formatMs(row.responseTimeMs)
                    : avg != null && row.d1.requests > 0
                      ? formatSec(avg)
                      : null;
                const meta = [
                  `#${row.channelId}`,
                  row.group || null,
                  row.tag || null,
                  multiSite ? row.siteName : null,
                  row.priority ? `P${row.priority}` : null,
                  formatAgo(row.d7.lastRequestAt ?? row.testAt, nowMs),
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <KumaMonitorRow
                    key={`${row.siteId}-${row.channelId}`}
                    name={row.name}
                    meta={meta}
                    beats={row.heartbeats}
                    uptime={row.uptime24h}
                    level={row.health}
                    ping={ping}
                    requests={row.d1.requests}
                    issues={row.d1.issues}
                    selected={detailKey === `${row.siteId}:${row.channelId}`}
                    onClick={() => void openDetail(row)}
                  />
                );
              })}
            </KumaPanel>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-muted">
            <span className="font-semibold text-secondary">图例</span>
            {(
              [
                ["#3bd671", "正常"],
                ["#f1c40f", "降级"],
                ["#dc3545", "严重"],
                ["#cfd8dc", "无流量"],
                ["#90a4ae", "禁用"],
              ] as const
            ).map(([color, label]) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-3 rounded-[1px]"
                  style={{ backgroundColor: color }}
                />
                {label}
              </span>
            ))}
          </div>
        </>
      )}

      {detailKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/80 p-4 backdrop-blur-[2px] sm:p-6"
          onClick={closeDetail}
          role="presentation"
        >
          <div
            className="flex max-h-[min(88vh,860px)] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] border border-border-subtle bg-surface-solid shadow-[0_24px_80px_-24px_var(--glass-shadow)] [animation:channel-modal-in_180ms_var(--ease-spring)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="渠道详情"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {detail && (
                    <>
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{
                          backgroundColor: levelColor(detail.channel.health),
                        }}
                      />
                      <KumaStatusPill level={detail.channel.health} />
                    </>
                  )}
                  <h2 className="truncate text-base font-semibold text-text sm:text-lg">
                    {detail?.channel.name || "渠道详情"}
                  </h2>
                </div>
                <p className="mt-1.5 text-xs text-muted">
                  {detail
                    ? `${detail.siteName} · #${detail.channel.channelId}${
                        detail.channel.group
                          ? ` · ${detail.channel.group}`
                          : ""
                      }`
                    : "加载中…"}
                </p>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={closeDetail}
                aria-label="关闭"
                className="h-9 w-9 shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              {detailLoading && (
                <div className="flex justify-center py-20">
                  <Spinner label="加载详情" />
                </div>
              )}
              {detailError && (
                <Callout tone="error" title="详情失败">
                  {detailError}
                </Callout>
              )}
              {detail && !detailLoading && (
                <div className="space-y-5">
                  <div className="rounded-[12px] border border-border-subtle bg-surface-2/50 p-4">
                    <div className="mb-3 flex items-end justify-between gap-3">
                      <div>
                        <div
                          className="font-data text-[32px] font-bold leading-none tracking-tight"
                          style={{
                            color: uptimeColor(detail.channel.uptime24h),
                          }}
                        >
                          {formatPct(detail.channel.uptime24h, 2)}
                        </div>
                        <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                          24h Uptime
                        </div>
                      </div>
                      <div className="text-right text-[11px] text-muted">
                        最后活跃
                        <div className="mt-0.5 font-medium text-secondary">
                          {formatAgo(detail.channel.d7.lastRequestAt, nowMs)}
                        </div>
                      </div>
                    </div>
                    <KumaHeartbeat
                      beats={detail.channel.heartbeats}
                      height={34}
                    />
                    <div className="mt-1.5 flex justify-between text-[10px] text-muted">
                      <span>24h 前</span>
                      <span>现在</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <Metric
                      icon={<ShieldAlert className="h-3.5 w-3.5" />}
                      label="24h 问题率"
                      value={formatIssuePct(detail.channel.d1.issueRate)}
                      danger={(detail.channel.d1.issueRate ?? 0) >= 0.05}
                    />
                    <Metric
                      icon={<Activity className="h-3.5 w-3.5" />}
                      label="24h 请求"
                      value={formatCompact(detail.channel.d1.requests)}
                    />
                    <Metric
                      icon={<Clock3 className="h-3.5 w-3.5" />}
                      label="平均耗时"
                      value={formatSec(
                        detail.channel.h1.avgUseTimeSec ??
                          detail.channel.d1.avgUseTimeSec,
                      )}
                    />
                    <Metric
                      icon={<AlertTriangle className="h-3.5 w-3.5" />}
                      label="测速"
                      value={formatMs(detail.channel.responseTimeMs)}
                      danger={(detail.channel.responseTimeMs ?? 0) >= 10000}
                    />
                  </div>

                  <div className="rounded-[12px] border border-border-subtle bg-surface-2/50 p-4 text-xs text-secondary">
                    <div className="mb-2 text-sm font-semibold text-text">
                      当前状态
                    </div>
                    <ul className="space-y-1.5">
                      {detail.channel.reasons.map((r) => (
                        <li key={r} className="flex items-start gap-2">
                          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted" />
                          <span className="leading-relaxed">{r}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {[
                        ["优先级", String(detail.channel.priority)],
                        ["权重", String(detail.channel.weight)],
                        ["自动封禁", detail.channel.autoBan ? "开" : "关"],
                        [
                          "1h 请求",
                          formatCompact(detail.channel.h1.requests),
                        ],
                        ["最后测速", formatAgo(detail.channel.testAt, nowMs)],
                        [
                          "最后请求",
                          formatAgo(detail.channel.d7.lastRequestAt, nowMs),
                        ],
                      ].map(([k, v]) => (
                        <div
                          key={k}
                          className="rounded-[8px] bg-surface-solid px-2.5 py-2"
                        >
                          <div className="text-[10px] text-muted">{k}</div>
                          <div className="mt-0.5 font-data text-[12px] font-semibold text-text">
                            {v}
                          </div>
                        </div>
                      ))}
                    </div>
                    {detail.channel.models.length > 0 && (
                      <div className="mt-3">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                          模型
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {detail.channel.models.slice(0, 16).map((m) => (
                            <Badge key={m} variant="default">
                              {m}
                            </Badge>
                          ))}
                          {detail.channel.models.length > 16 && (
                            <Badge variant="default">
                              +{detail.channel.models.length - 16}
                            </Badge>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <section>
                    <h3 className="mb-2.5 text-sm font-semibold text-text">
                      24h 模型拆分
                    </h3>
                    {detail.models24h.length === 0 ? (
                      <p className="rounded-[10px] border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-muted">
                        近 24h 无消费日志。
                      </p>
                    ) : (
                      <TableWrap>
                        <Table>
                          <THead>
                            <HeadRow>
                              <TH>模型</TH>
                              <TH className="text-right">请求</TH>
                              <TH className="text-right">问题</TH>
                              <TH className="text-right">耗时</TH>
                            </HeadRow>
                          </THead>
                          <TBody>
                            {detail.models24h.map((m) => (
                              <TR key={m.model}>
                                <TD className="max-w-[10rem] truncate font-medium">
                                  {m.model}
                                </TD>
                                <TD className="text-right font-data tabular-nums">
                                  {m.requests}
                                </TD>
                                <TD
                                  className={cn(
                                    "text-right font-data tabular-nums",
                                    m.issues > 0 && "text-coral",
                                  )}
                                >
                                  {m.issues}
                                  {m.issueRate != null && m.issues > 0
                                    ? ` (${formatIssuePct(m.issueRate)})`
                                    : ""}
                                </TD>
                                <TD className="text-right font-data tabular-nums text-secondary">
                                  {formatSec(m.avgUseTimeSec)}
                                </TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </TableWrap>
                    )}
                  </section>

                  <section>
                    <h3 className="mb-2.5 text-sm font-semibold text-text">
                      最近问题
                    </h3>
                    {detail.recentIssues.length === 0 ? (
                      <p className="rounded-[10px] border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-muted">
                        近 7 天没有匹配的问题日志。
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {detail.recentIssues.map((issue, idx) => (
                          <li
                            key={`${issue.at}-${idx}`}
                            className="rounded-[10px] border border-border-subtle bg-surface-2/60 px-3.5 py-2.5"
                          >
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                              <span className="font-data">
                                {formatTime(issue.at)}
                              </span>
                              {issue.model && (
                                <Badge variant="default">{issue.model}</Badge>
                              )}
                              {issue.useTimeSec != null && (
                                <span className="font-data">
                                  {formatSec(issue.useTimeSec)}
                                </span>
                              )}
                              {issue.username && (
                                <span>@{issue.username}</span>
                              )}
                            </div>
                            <p className="mt-1.5 text-xs leading-relaxed text-text">
                              {issue.content || "（无 content）"}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  danger,
}: {
  label: string;
  value: string;
  icon: React.ReactElement;
  danger?: boolean;
}) {
  return (
    <div className="rounded-[10px] border border-border-subtle bg-surface-2/50 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full",
            danger ? "bg-coral/12 text-coral" : "bg-surface-3 text-secondary",
          )}
        >
          {icon}
        </span>
        {label}
      </div>
      <div
        className={cn(
          "mt-2 font-data text-[18px] font-bold tabular-nums tracking-tight",
          danger ? "text-coral" : "text-text",
        )}
      >
        {value}
      </div>
    </div>
  );
}
