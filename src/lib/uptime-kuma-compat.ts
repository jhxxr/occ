/**
 * 把分组 Uptime 投影成 Uptime Kuma Status Page 兼容结构，
 * 供 NewAPI `console_setting.uptime_kuma_groups` 直接绑定：
 *
 *   url  = https://你的控制台域名
 *   slug = occ_xxx（对外 API Token）
 *
 * NewAPI 会请求：
 *   GET {url}/api/status-page/{slug}
 *   GET {url}/api/status-page/heartbeat/{slug}
 */

import { createHash } from "crypto";
import type {
  PublicGroupUptime,
  PublicGroupUptimePayload,
} from "@/lib/public-group-uptime";
import type { HeartbeatTone } from "@/lib/channel-health";

/** Uptime Kuma heartbeat.status */
export const KUMA_STATUS = {
  DOWN: 0,
  UP: 1,
  PENDING: 2,
  MAINTENANCE: 3,
} as const;

export interface KumaStatusPagePayload {
  config: {
    slug: string;
    title: string;
    description: string;
    theme: string;
    published: boolean;
    showTags: boolean;
    /** 固定上海时区，与内部报表一致 */
    timezone: string;
  };
  publicGroupList: Array<{
    id: number;
    name: string;
    weight: number;
    monitorList: Array<{
      id: number;
      name: string;
      sendUrl: number;
      type: string;
    }>;
  }>;
  incident: null;
}

export interface KumaHeartbeatPayload {
  heartbeatList: Record<
    string,
    Array<{
      status: number;
      time: string;
      msg: string;
      ping: number | null;
    }>
  >;
  /** key = `${monitorId}_24`，值为 0–1 小数（NewAPI 前端再 *100） */
  uptimeList: Record<string, number>;
}

function stablePositiveInt(seed: string, salt: string): number {
  const hex = createHash("sha256").update(`${salt}\0${seed}`).digest("hex");
  // 取 31 bit，避免 JS/JSON 整型溢出；保证 > 0
  const n = Number.parseInt(hex.slice(0, 8), 16) & 0x7fffffff;
  return n === 0 ? 1 : n;
}

/** 对外稳定 monitor id：不暴露内部 siteId */
export function publicMonitorId(groupKey: string): number {
  return stablePositiveInt(groupKey, "orbit-monitor");
}

function publicGroupId(siteName: string): number {
  return stablePositiveInt(siteName || "default", "orbit-public-group");
}

function toneToKumaStatus(tone: HeartbeatTone, health: PublicGroupUptime["health"]): number {
  switch (tone) {
    case "up":
      return KUMA_STATUS.UP;
    case "degraded":
      // Kuma 无 degraded，用 PENDING(高延迟/告警) 让 NewAPI 显示琥珀色
      return KUMA_STATUS.PENDING;
    case "down":
      return KUMA_STATUS.DOWN;
    case "empty":
      return KUMA_STATUS.MAINTENANCE;
    case "pending":
    default:
      // 无流量：按分组整体健康兜底
      if (health === "critical") return KUMA_STATUS.DOWN;
      if (health === "degraded") return KUMA_STATUS.PENDING;
      if (health === "idle") return KUMA_STATUS.MAINTENANCE;
      if (health === "silent") return KUMA_STATUS.PENDING;
      return KUMA_STATUS.PENDING;
  }
}

function groupLatestStatus(g: PublicGroupUptime): number {
  switch (g.health) {
    case "healthy":
      return KUMA_STATUS.UP;
    case "degraded":
    case "silent":
      return KUMA_STATUS.PENDING;
    case "critical":
      return KUMA_STATUS.DOWN;
    case "idle":
    case "disabled":
      return KUMA_STATUS.MAINTENANCE;
    default:
      return KUMA_STATUS.PENDING;
  }
}

function uptimeRatio(uptime24h: number | null): number {
  if (uptime24h == null || !Number.isFinite(uptime24h)) return 0;
  // 内部是 0–100，Kuma / NewAPI 要 0–1
  const ratio = uptime24h / 100;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return Math.round(ratio * 1_000_000) / 1_000_000;
}

function monitorName(g: PublicGroupUptime): string {
  // 站点名已在 publicGroupList 分组标题里展示，monitor 只保留分组标签
  return g.label?.trim() || g.group?.trim() || "未分组";
}

function groupBucketName(g: PublicGroupUptime): string {
  return g.siteName?.trim() || "默认";
}

/** 故障靠前；正常其次；静默 / 闲置 / 无调用沉底 */
const KUMA_HEALTH_SORT: Record<PublicGroupUptime["health"], number> = {
  critical: 0,
  degraded: 1,
  healthy: 2,
  silent: 3,
  idle: 4,
  disabled: 5,
};

function isQuietGroup(g: PublicGroupUptime): boolean {
  return (
    g.health === "silent" ||
    g.health === "idle" ||
    g.health === "disabled" ||
    g.requests24h === 0 ||
    g.monitoredCount === 0
  );
}

function sortGroupsForKuma(groups: PublicGroupUptime[]): PublicGroupUptime[] {
  return [...groups].sort((a, b) => {
    const hs = KUMA_HEALTH_SORT[a.health] - KUMA_HEALTH_SORT[b.health];
    if (hs !== 0) return hs;
    const aq = isQuietGroup(a) ? 1 : 0;
    const bq = isQuietGroup(b) ? 1 : 0;
    if (aq !== bq) return aq - bq;
    const ua = a.uptime24h ?? 101;
    const ub = b.uptime24h ?? 101;
    if (ua !== ub) return ua - ub;
    if (b.requests24h !== a.requests24h) return b.requests24h - a.requests24h;
    return monitorName(a).localeCompare(monitorName(b), "zh-CN");
  });
}

/** 按站点拆成 Kuma publicGroupList */
export function toKumaStatusPage(
  data: PublicGroupUptimePayload,
  slug: string,
): KumaStatusPagePayload {
  const bySite = new Map<string, PublicGroupUptime[]>();
  for (const g of data.groups) {
    const site = groupBucketName(g);
    let list = bySite.get(site);
    if (!list) {
      list = [];
      bySite.set(site, list);
    }
    list.push(g);
  }

  const publicGroupList = [...bySite.entries()].map(([siteName, groups], idx) => ({
    id: publicGroupId(siteName),
    name: siteName,
    weight: idx + 1,
    monitorList: sortGroupsForKuma(groups).map((g) => ({
      id: publicMonitorId(g.key),
      name: monitorName(g),
      sendUrl: 0,
      type: "http",
    })),
  }));

  return {
    config: {
      slug,
      title: "Orbit Group Uptime",
      description: "中转站分组 24h 可用性（Asia/Shanghai）",
      theme: "auto",
      published: true,
      showTags: false,
      timezone: "Asia/Shanghai",
    },
    publicGroupList,
    incident: null,
  };
}

/** heartbeat + uptimeList，供 NewAPI 拼装 monitor 状态条 */
export function toKumaHeartbeat(
  data: PublicGroupUptimePayload,
): KumaHeartbeatPayload {
  const heartbeatList: KumaHeartbeatPayload["heartbeatList"] = {};
  const uptimeList: KumaHeartbeatPayload["uptimeList"] = {};

  for (const g of data.groups) {
    const id = String(publicMonitorId(g.key));
    const beats = g.heartbeats || [];
    // 内部 heartbeats 是旧→新；Kuma / NewAPI 取 [0] 为当前状态，故输出新→旧
    const mapped = beats.map((b) => ({
      status: toneToKumaStatus(b.tone, g.health),
      time: b.hourStart,
      msg:
        b.requests > 0
          ? `${b.requests} req / ${b.issues} issue`
          : b.tone === "empty"
            ? "disabled"
            : "no traffic",
      ping:
        b.avgUseTimeSec != null && Number.isFinite(b.avgUseTimeSec)
          ? Math.round(b.avgUseTimeSec * 1000)
          : null,
    }));
    mapped.reverse();

    heartbeatList[id] =
      mapped.length > 0
        ? mapped
        : [
            {
              status: groupLatestStatus(g),
              time: data.fetchedAt,
              msg: "no heartbeat",
              ping: g.bestResponseTimeMs,
            },
          ];

    uptimeList[`${id}_24`] = uptimeRatio(g.uptime24h);
  }

  return { heartbeatList, uptimeList };
}

/**
 * 路径 slug 可能被 URL 解码；token 本身是 base64url，通常无需特殊处理。
 * 这里做 trim，拒绝空串与明显路径穿越。
 */
export function normalizeStatusSlug(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const slug = raw.trim();
  if (!slug) return null;
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) return null;
  // occ_ + base64url；也允许将来扩展，但挡住空白/控制字符
  if (!/^[A-Za-z0-9._~_-]+$/.test(slug)) return null;
  return slug;
}

