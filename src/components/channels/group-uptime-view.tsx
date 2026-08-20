"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { Input, Select } from "@/components/ui/input";
import { cn, formatCompact } from "@/lib/utils";
import { errorOf, readJson } from "@/lib/sync-client";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  ChannelHealthPayload,
  GroupUptimeRow,
} from "@/lib/channel-health";
import {
  formatAgo,
  formatMs,
  formatPct,
  formatSec,
  formatTime,
  KumaHeartbeat,
  KumaOverallBanner,
  KumaPanel,
  KumaStatusPill,
  KumaToolbar,
  levelColor,
  uptimeColor,
} from "@/components/channels/uptime-shared";

type FilterKey = "all" | "down" | "up" | "quiet" | "maintenance";

const FILTERS: { value: FilterKey; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "down", label: "异常" },
  { value: "up", label: "正常" },
  { value: "quiet", label: "静默" },
  { value: "maintenance", label: "维护/闲置" },
];

function matchesFilter(row: GroupUptimeRow, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "down") return row.downCount > 0;
  if (filter === "up") return row.downCount === 0 && row.healthy > 0;
  if (filter === "quiet") return row.silent > 0 && row.downCount === 0;
  if (filter === "maintenance") {
    return row.monitoredCount === 0 && (row.disabledCount > 0 || row.idle > 0);
  }
  return true;
}

function GroupRow({
  row,
  nowMs,
  multiSite,
  expanded,
  onToggle,
}: {
  row: GroupUptimeRow;
  nowMs: number;
  multiSite: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = [
    multiSite ? row.siteName : null,
    `${row.channelCount} 渠道`,
    row.downCount > 0 ? `异常 ${row.downCount}` : null,
    row.silent > 0 ? `静默 ${row.silent}` : null,
    row.avgUseTimeSec24h != null
      ? `均耗时 ${formatSec(row.avgUseTimeSec24h)}`
      : null,
    row.bestResponseTimeMs != null
      ? `最快 ${formatMs(row.bestResponseTimeMs)}`
      : null,
    formatAgo(row.lastRequestAt, nowMs),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-b border-border-subtle/80 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-1 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/70 sm:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)_auto_auto_auto] sm:gap-4 sm:px-5"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: levelColor(row.health) }}
            />
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-text">
              {row.label}
            </span>
            <span className="text-muted">
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          </div>
          <p className="mt-1 truncate pl-[18px] text-[11.5px] text-muted">
            {meta}
          </p>
        </div>

        <div className="min-w-0">
          <KumaHeartbeat beats={row.heartbeats} height={26} />
          <div className="mt-1 hidden justify-between text-[10px] text-muted sm:flex">
            <span>24h 前</span>
            <span className="font-data">
              {formatCompact(row.requests24h)} req
              {row.issues24h > 0 ? ` · ${row.issues24h} err` : ""}
            </span>
            <span>现在</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 sm:contents">
          <div
            className="font-data text-[18px] font-bold tabular-nums tracking-tight sm:min-w-[5.5rem] sm:text-right sm:text-[20px]"
            style={{ color: uptimeColor(row.uptime24h) }}
          >
            {formatPct(row.uptime24h, 2)}
          </div>
          <KumaStatusPill level={row.health} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border-subtle/70 bg-surface-2/40 px-4 py-3 sm:px-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-secondary">
              组内渠道
            </span>
            <Link
              href={`/channels?group=${encodeURIComponent(row.group)}&siteId=${encodeURIComponent(row.siteId)}`}
              className="text-[11px] font-medium text-accent hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              在渠道健康中查看 →
            </Link>
          </div>
          <div className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface-solid">
            {row.channels.map((ch, idx) => (
              <div
                key={`${ch.siteId}-${ch.channelId}`}
                className={cn(
                  "grid grid-cols-1 items-center gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto_auto]",
                  idx > 0 && "border-t border-border-subtle/70",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: levelColor(ch.health) }}
                    />
                    <span className="truncate text-[13px] font-medium text-text">
                      {ch.name}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate pl-[16px] text-[11px] text-muted">
                    #{ch.channelId}
                    {ch.priority ? ` · P${ch.priority}` : ""}
                    {ch.tag ? ` · ${ch.tag}` : ""}
                    {" · "}
                    {formatCompact(ch.d1.requests)}/24h
                  </p>
                </div>
                <div className="min-w-0 pl-4 sm:pl-0">
                  <KumaHeartbeat beats={ch.heartbeats} height={18} />
                </div>
                <div
                  className="pl-4 font-data text-[14px] font-bold tabular-nums sm:min-w-[4.5rem] sm:pl-0 sm:text-right"
                  style={{ color: uptimeColor(ch.uptime24h) }}
                >
                  {formatPct(ch.uptime24h, 2)}
                </div>
                <div className="pl-4 sm:pl-0">
                  <KumaStatusPill level={ch.health} className="min-w-[4rem]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function GroupUptimeView() {
  const [data, setData] = useState<ChannelHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [siteId, setSiteId] = useState("all");
  const [query, setQuery] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const siteOptions = useMemo(() => {
    const sites = data?.sites || [];
    return [
      { id: "all", name: "全部站点" },
      ...sites.map((s) => ({ id: s.siteId, name: s.siteName })),
    ];
  }, [data]);

  const groups = useMemo(() => {
    let rows = data?.groups || [];
    if (siteId !== "all") rows = rows.filter((r) => r.siteId === siteId);
    rows = rows.filter((r) => matchesFilter(r, filter));
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => {
        const hay = [
          r.label,
          r.group,
          r.siteName,
          ...r.channels.map((c) => c.name),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return rows;
  }, [data, siteId, filter, query]);

  const overview = useMemo(() => {
    const rows = groups;
    let req = 0;
    let ok = 0;
    let down = 0;
    let monitored = 0;
    let silent = 0;
    for (const g of rows) {
      down += g.downCount;
      monitored += g.monitoredCount;
      silent += g.silent;
      if (g.requests24h > 0) {
        req += g.requests24h;
        ok += Math.max(0, g.requests24h - g.issues24h);
      }
    }
    const uptime24h = req > 0 ? Math.round((ok / req) * 10000) / 100 : null;
    const tone =
      monitored === 0 && rows.length > 0
        ? ("idle" as const)
        : down > 0
          ? ("down" as const)
          : monitored > 0
            ? ("up" as const)
            : ("idle" as const);
    return {
      groupCount: rows.length,
      down,
      monitored,
      silent,
      uptime24h,
      requests24h: req,
      tone,
      title:
        tone === "down"
          ? `${down} 个渠道异常`
          : tone === "up"
            ? silent > 0
              ? "运行正常"
              : "All Systems Operational"
            : rows.length === 0
              ? "暂无分组"
              : "部分维护中",
      subtitle: `${rows.length} 个分组 · 监控 ${monitored} · 静默 ${silent} · 24h ${formatCompact(req)} 请求`,
    };
  }, [groups]);

  const multiSite = (data?.sites.length || 0) > 1;
  const unbound = (data?.sites || []).filter((s) => !s.dbBound);
  const failed = (data?.sites || []).filter((s) => s.dbBound && !s.ok);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <TopBar
        title="分组 Uptime"
        subtitle="Kuma 风格状态页 · 按渠道分组"
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
            href="/channels"
            className="inline-flex h-9 items-center rounded-full px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-2 hover:text-text"
          >
            渠道明细
          </Link>
        </div>
        <div className="relative min-w-0 flex-1 sm:max-w-xs sm:flex-none">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索分组 / 渠道"
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
          <Spinner label="加载分组 Uptime" />
        </KumaPanel>
      ) : (
        <>
          <KumaOverallBanner
            title={overview.title}
            subtitle={overview.subtitle}
            tone={overview.tone}
            uptime={overview.uptime24h}
          />

          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <Segmented
              ariaLabel="分组状态筛选"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={FILTERS}
            />
            <div className="text-xs text-muted">
              <span className="font-data font-medium text-secondary">
                {groups.length}
              </span>{" "}
              个分组
            </div>
          </div>

          {groups.length === 0 ? (
            <KumaPanel className="px-5 py-16 text-center">
              <p className="text-sm font-medium text-secondary">
                {data && (data.groups?.length || 0) === 0
                  ? "还没有可展示的分组"
                  : "当前筛选下没有分组"}
              </p>
              <p className="mt-1 text-xs text-muted">
                {data && (data.groups?.length || 0) === 0
                  ? "请先在下游站点绑定只读数据库。"
                  : "试试切换筛选或清空搜索。"}
              </p>
            </KumaPanel>
          ) : (
            <KumaPanel>
              {groups.map((row) => (
                <GroupRow
                  key={row.key}
                  row={row}
                  nowMs={nowMs}
                  multiSite={multiSite}
                  expanded={!!expanded[row.key]}
                  onToggle={() =>
                    setExpanded((prev) => ({
                      ...prev,
                      [row.key]: !prev[row.key],
                    }))
                  }
                />
              ))}
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
            <span className="text-border">·</span>
            <span>Uptime = 1 − 问题 / 请求（流量加权）</span>
          </div>
        </>
      )}
    </div>
  );
}
