"use client";

import type { ReactNode } from "react";
import { cn, formatCompact } from "@/lib/utils";
import type {
  ChannelHealthLevel,
  ChannelHeartbeatBucket,
  HeartbeatTone,
} from "@/lib/channel-health";

/** Uptime Kuma 式状态色：实心、克制、高对比 */
export const KUMA = {
  up: "#3bd671",
  degraded: "#f1c40f",
  down: "#dc3545",
  paused: "#90a4ae",
  pending: "#cfd8dc",
  maintenance: "#5c6bc0",
  silent: "#9b7bff",
} as const;

export function formatPct(rate: number | null | undefined, digits = 2): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${rate.toFixed(digits)}%`;
}

export function formatIssuePct(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec >= 60) return `${(sec / 60).toFixed(1)}m`;
  return `${sec % 1 === 0 ? sec : sec.toFixed(1)}s`;
}

export function formatAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, nowMs - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function uptimeColor(uptime: number | null | undefined): string {
  if (uptime == null) return "var(--muted)";
  if (uptime >= 99) return KUMA.up;
  if (uptime >= 95) return KUMA.degraded;
  return KUMA.down;
}

export function levelColor(level: ChannelHealthLevel): string {
  switch (level) {
    case "healthy":
      return KUMA.up;
    case "degraded":
      return KUMA.degraded;
    case "critical":
      return KUMA.down;
    case "silent":
      return KUMA.silent;
    case "idle":
      return KUMA.maintenance;
    default:
      return KUMA.paused;
  }
}

export function levelLabel(level: ChannelHealthLevel): string {
  switch (level) {
    case "healthy":
      return "Up";
    case "degraded":
      return "Degraded";
    case "critical":
      return "Down";
    case "silent":
      return "Silent";
    case "idle":
      return "Idle";
    default:
      return "Paused";
  }
}

const BEAT_HEX: Record<HeartbeatTone, string> = {
  up: KUMA.up,
  degraded: KUMA.degraded,
  down: KUMA.down,
  empty: KUMA.paused,
  pending: KUMA.pending,
};

/** Kuma 风格等高峰心跳条 */
export function KumaHeartbeat({
  beats,
  className,
  height = 28,
}: {
  beats: ChannelHeartbeatBucket[];
  className?: string;
  height?: number;
}) {
  return (
    <div
      className={cn("flex w-full items-stretch gap-px sm:gap-[2px]", className)}
      style={{ height }}
      role="img"
      aria-label="近 24 小时心跳"
    >
      {beats.map((b) => {
        const tip = [
          b.label,
          b.requests > 0
            ? `${b.requests} 请求 · 问题 ${b.issues}${
                b.issueRate != null ? ` (${formatIssuePct(b.issueRate)})` : ""
              }`
            : b.tone === "empty"
              ? "已禁用"
              : "无流量",
          b.avgUseTimeSec != null ? `均耗时 ${formatSec(b.avgUseTimeSec)}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={b.hourStart + b.label}
            title={tip}
            className="min-w-0 flex-1 rounded-[1px] transition-[filter] duration-150 hover:brightness-110"
            style={{
              backgroundColor: BEAT_HEX[b.tone],
              opacity: b.tone === "pending" ? 0.55 : b.tone === "empty" ? 0.45 : 1,
            }}
          />
        );
      })}
    </div>
  );
}

/** 右侧状态胶囊：Up / Down / … */
export function KumaStatusPill({
  level,
  className,
}: {
  level: ChannelHealthLevel;
  className?: string;
}) {
  const color = levelColor(level);
  return (
    <span
      className={cn(
        "inline-flex min-w-[4.5rem] items-center justify-center rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow-sm",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {levelLabel(level)}
    </span>
  );
}

/** 顶部总览条：All Systems Operational */
export function KumaOverallBanner({
  title,
  subtitle,
  tone,
  uptime,
  uptimeLabel = "24h Uptime",
}: {
  title: string;
  subtitle?: string;
  tone: "up" | "down" | "mixed" | "idle";
  uptime?: number | null;
  uptimeLabel?: string;
}) {
  const bg =
    tone === "up"
      ? KUMA.up
      : tone === "down"
        ? KUMA.down
        : tone === "mixed"
          ? KUMA.degraded
          : KUMA.paused;

  return (
    <div
      className="overflow-hidden rounded-[12px] text-white shadow-sm"
      style={{ backgroundColor: bg }}
    >
      <div className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-6">
        <div className="min-w-0">
          <div className="text-[22px] font-bold tracking-[-0.02em] sm:text-[26px]">
            {title}
          </div>
          {subtitle && (
            <p className="mt-1 text-sm font-medium text-white/85">{subtitle}</p>
          )}
        </div>
        {uptime !== undefined && (
          <div className="shrink-0 text-left sm:text-right">
            <div className="font-data text-[28px] font-bold leading-none tracking-tight sm:text-[32px]">
              {formatPct(uptime ?? null, 2)}
            </div>
            <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/75">
              {uptimeLabel}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 监控行：名称 | 心跳 | uptime% | 状态 */
export function KumaMonitorRow({
  name,
  meta,
  beats,
  uptime,
  level,
  ping,
  requests,
  issues,
  selected,
  onClick,
  trailing,
}: {
  name: string;
  meta?: string;
  beats: ChannelHeartbeatBucket[];
  uptime: number | null;
  level: ChannelHealthLevel;
  ping?: string | null;
  requests?: number;
  issues?: number;
  selected?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "group grid w-full grid-cols-1 items-center gap-3 border-b border-border-subtle/80 px-4 py-3.5 text-left transition-colors last:border-b-0",
        "sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_auto_auto] sm:gap-4 sm:px-5",
        onClick && "cursor-pointer hover:bg-surface-2/80",
        selected && "bg-accent/6",
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: levelColor(level) }}
            aria-hidden
          />
          <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-text">
            {name}
          </span>
          {trailing}
        </div>
        {meta && (
          <p className="mt-1 truncate pl-[18px] text-[11.5px] text-muted">
            {meta}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-[18px] text-[11px] text-muted sm:hidden">
          {ping && <span className="font-data">{ping}</span>}
          {requests != null && (
            <span className="font-data">{formatCompact(requests)}/24h</span>
          )}
          {issues != null && issues > 0 && (
            <span className="font-data" style={{ color: KUMA.down }}>
              {issues} 问题
            </span>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <KumaHeartbeat beats={beats} height={26} />
        <div className="mt-1 hidden justify-between text-[10px] text-muted sm:flex">
          <span>24h 前</span>
          <span className="hidden items-center gap-3 md:inline-flex">
            {ping && <span className="font-data">{ping}</span>}
            {requests != null && (
              <span className="font-data">{formatCompact(requests)} req</span>
            )}
            {issues != null && issues > 0 && (
              <span className="font-data" style={{ color: KUMA.down }}>
                {issues} err
              </span>
            )}
          </span>
          <span>现在</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 sm:contents">
        <div
          className="font-data text-[18px] font-bold tabular-nums tracking-tight sm:min-w-[5.5rem] sm:text-right sm:text-[20px]"
          style={{ color: uptimeColor(uptime) }}
        >
          {formatPct(uptime, 2)}
        </div>
        <KumaStatusPill level={level} className="sm:justify-self-end" />
      </div>
    </Comp>
  );
}

export function KumaPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[12px] border border-border-subtle bg-surface-solid shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function KumaToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[12px] border border-border-subtle bg-surface-solid p-2.5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-3">
      {children}
    </div>
  );
}

export { formatCompact };
