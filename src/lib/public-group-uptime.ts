import { createHash } from "crypto";
import {
  getChannelHealth,
  type ChannelHealthLevel,
  type ChannelHeartbeatBucket,
  type GroupUptimeRow,
} from "@/lib/channel-health";

/** 对外公开的分组 uptime（不含具体渠道/上游细节） */
export interface PublicGroupUptime {
  /** 稳定对外键（不暴露内部 siteId） */
  key: string;
  /** 站点显示名 */
  siteName: string;
  /** 分组原始名；空为未分组 */
  group: string;
  /** 展示名 */
  label: string;
  health: ChannelHealthLevel;
  uptime24h: number | null;
  requests24h: number;
  issues24h: number;
  issueRate24h: number | null;
  requests1h: number;
  issues1h: number;
  avgUseTimeSec24h: number | null;
  bestResponseTimeMs: number | null;
  lastRequestAt: string | null;
  channelCount: number;
  enabledCount: number;
  disabledCount: number;
  monitoredCount: number;
  downCount: number;
  healthy: number;
  degraded: number;
  critical: number;
  silent: number;
  idle: number;
  heartbeats: ChannelHeartbeatBucket[];
}

export interface PublicGroupUptimePayload {
  fetchedAt: string;
  summary: {
    groupCount: number;
    monitoredCount: number;
    downCount: number;
    upCount: number;
    silentCount: number;
    uptime24h: number | null;
    requests24h: number;
    issues24h: number;
  };
  groups: PublicGroupUptime[];
}

/** 对外稳定键：hash(siteId\0group)，避免泄漏内部 siteId */
function publicGroupKey(siteId: string, group: string): string {
  return createHash("sha256")
    .update(`${siteId}\0${group}`)
    .digest("hex")
    .slice(0, 16);
}

function sanitizeGroup(row: GroupUptimeRow): PublicGroupUptime {
  return {
    key: publicGroupKey(row.siteId, row.group),
    siteName: row.siteName,
    group: row.group,
    label: row.label,
    health: row.health,
    uptime24h: row.uptime24h,
    requests24h: row.requests24h,
    issues24h: row.issues24h,
    issueRate24h: row.issueRate24h,
    requests1h: row.requests1h,
    issues1h: row.issues1h,
    avgUseTimeSec24h: row.avgUseTimeSec24h,
    bestResponseTimeMs: row.bestResponseTimeMs,
    lastRequestAt: row.lastRequestAt,
    channelCount: row.channelCount,
    enabledCount: row.enabledCount,
    disabledCount: row.disabledCount,
    monitoredCount: row.monitoredCount,
    downCount: row.downCount,
    healthy: row.healthy,
    degraded: row.degraded,
    critical: row.critical,
    silent: row.silent,
    idle: row.idle,
    heartbeats: row.heartbeats,
  };
}

function tallyPublic(groups: PublicGroupUptime[]) {
  let monitored = 0;
  let down = 0;
  let up = 0;
  let silent = 0;
  let req = 0;
  let issues = 0;
  let ok = 0;

  for (const g of groups) {
    monitored += g.monitoredCount;
    down += g.downCount;
    silent += g.silent;
    if (g.health === "healthy") up += 1;
    if (g.requests24h > 0) {
      req += g.requests24h;
      issues += g.issues24h;
      ok += Math.max(0, g.requests24h - g.issues24h);
    }
  }

  return {
    groupCount: groups.length,
    monitoredCount: monitored,
    downCount: down,
    upCount: up,
    silentCount: silent,
    uptime24h: req > 0 ? Math.round((ok / req) * 10000) / 100 : null,
    requests24h: req,
    issues24h: issues,
  };
}

/**
 * 对外公开数据：只暴露分组级 uptime。
 * 不返回具体渠道名、模型、上游、DSN、内部 siteId。
 */
export async function getPublicGroupUptime(opts?: {
  /** 按站点显示名过滤（可选） */
  siteName?: string;
}): Promise<PublicGroupUptimePayload> {
  const health = await getChannelHealth();
  let groups = (health.groups || []).map(sanitizeGroup);

  const siteName = opts?.siteName?.trim();
  if (siteName) {
    const q = siteName.toLowerCase();
    groups = groups.filter((g) => g.siteName.toLowerCase() === q);
  }

  return {
    fetchedAt: health.fetchedAt,
    summary: tallyPublic(groups),
    groups,
  };
}
