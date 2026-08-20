/**
 * 下游 NewAPI 渠道健康监控
 *
 * 只读已绑定 DSN 的下游库：channels 配置 + logs 近窗聚合。
 * 不落本地缓存；打开页面时现查，窗口最多 7 天。
 *
 * 健康档位（默认阈值，可在 THRESHOLDS 调）：
 *   disabled  渠道 status ≠ 启用
 *   critical  问题率 ≥ 15%（样本够）或测速 ≥ 30s
 *   degraded  问题率 ≥ 5% / 测速 ≥ 10s / 近窗耗时偏高
 *   silent    启用且 7 天有量，但近 2h 归零
 *   idle      启用但 7 天几乎无请求
 *   healthy   其余
 */

import type { RowDataPacket } from "mysql2";
import type mysql from "mysql2/promise";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { withNewApiDb } from "@/lib/newapi-db";

/** NewAPI channel.status：1=启用，2=手动禁用（常见），其它非 1 一律当未启用 */
const CHANNEL_STATUS_ENABLED = 1;

/** logs.type=2 消费；问题主要写在 content，不一定有独立 error type */
const LOG_TYPE_CONSUME = 2;

const DEFAULT_QUOTA_PER_DOLLAR = 500_000;

export const HEALTH_THRESHOLDS = {
  /** 问题率达到此值且样本够 → degraded */
  issueRateDegraded: 0.05,
  /** 问题率达到此值且样本够 → critical */
  issueRateCritical: 0.15,
  /** 计算问题率的最少请求数，避免 1/1=100% 误报 */
  minRequestsForRate: 5,
  /** channels.response_time（毫秒）慢 */
  responseTimeSlowMs: 10_000,
  /** channels.response_time（毫秒）极慢 */
  responseTimeCriticalMs: 30_000,
  /** logs.use_time（秒）均值偏高 → degraded */
  avgUseTimeSlowSec: 120,
  /** 近窗无流量判定静默的小时数 */
  silentHours: 2,
  /** 7 天至少这么多请求才谈得上「静默」而不是闲置 */
  silentMin7dRequests: 5,
  /** 拉最近问题样本条数 */
  recentIssueLimit: 8,
  /** 详情页模型拆分最多行 */
  modelBreakdownLimit: 12,
  /** Uptime 心跳条：近 N 小时，每小时一格 */
  heartbeatHours: 24,
} as const;

export type ChannelHealthLevel =
  | "critical"
  | "degraded"
  | "silent"
  | "disabled"
  | "idle"
  | "healthy";

export interface ChannelWindowStats {
  requests: number;
  issues: number;
  issueRate: number | null;
  quota: number;
  quotaUsd: number;
  avgUseTimeSec: number | null;
  maxUseTimeSec: number | null;
  lastRequestAt: string | null;
}

/** 单小时心跳格：对齐 Uptime Kuma 的历史条 */
export type HeartbeatTone = "up" | "degraded" | "down" | "empty" | "pending";

export interface ChannelHeartbeatBucket {
  /** 该小时起点 ISO */
  hourStart: string;
  /** 展示用标签，如 14:00 */
  label: string;
  requests: number;
  issues: number;
  issueRate: number | null;
  avgUseTimeSec: number | null;
  tone: HeartbeatTone;
}

export interface ChannelHealthRow {
  siteId: string;
  siteName: string;
  channelId: number;
  name: string;
  status: number;
  enabled: boolean;
  group: string;
  tag: string;
  priority: number;
  weight: number;
  type: number;
  models: string[];
  modelCount: number;
  /** 测速延迟，毫秒；0 / 未测为 null */
  responseTimeMs: number | null;
  testAt: string | null;
  balance: number | null;
  usedQuota: number;
  usedQuotaUsd: number;
  autoBan: boolean;
  remark: string;
  health: ChannelHealthLevel;
  reasons: string[];
  /**
   * 近 24h 可用性（0–100）。
   * = 1 − issues/requests；无流量时 null（不算进整体 uptime）。
   */
  uptime24h: number | null;
  /** 近 24h 心跳条，从旧到新共 heartbeatHours 格 */
  heartbeats: ChannelHeartbeatBucket[];
  h1: ChannelWindowStats;
  h2: ChannelWindowStats;
  d1: ChannelWindowStats;
  d7: ChannelWindowStats;
}

export interface ChannelHealthSummary {
  total: number;
  /** channels.status === 启用 */
  statusEnabled: number;
  /** channels.status !== 启用（与 health.disabled 同值，语义是配置态） */
  statusDisabled: number;
  critical: number;
  degraded: number;
  silent: number;
  disabled: number;
  idle: number;
  healthy: number;
  /**
   * 监控中渠道（排除 disabled/idle）的 24h 请求加权可用性 0–100。
   * 没有流量样本时为 null。
   */
  uptime24h: number | null;
  /** 当前视为 Up 的监控数（healthy） */
  upCount: number;
  /** 当前视为异常的监控数（critical + degraded；静默不算异常） */
  downCount: number;
  /** 纳入 uptime 计算的监控数 */
  monitoredCount: number;
}

export interface ChannelHealthSiteResult {
  siteId: string;
  siteName: string;
  enabled: boolean;
  dbBound: boolean;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  fetchedAt?: string;
  summary: ChannelHealthSummary;
  channels: ChannelHealthRow[];
}

export interface ChannelHealthPayload {
  fetchedAt: string;
  thresholds: typeof HEALTH_THRESHOLDS;
  sites: ChannelHealthSiteResult[];
  summary: ChannelHealthSummary;
  channels: ChannelHealthRow[];
  /** 按 NewAPI channels.group 聚合的 24h uptime */
  groups: GroupUptimeRow[];
}

/** 单分组 Uptime 汇总（可跨站；同名分组按 site 拆开） */
export interface GroupUptimeRow {
  /** siteId + group 唯一键 */
  key: string;
  siteId: string;
  siteName: string;
  /** 原始 group 字段；空串展示为「未分组」 */
  group: string;
  label: string;
  channelCount: number;
  enabledCount: number;
  disabledCount: number;
  healthy: number;
  degraded: number;
  critical: number;
  silent: number;
  idle: number;
  /** critical + degraded */
  downCount: number;
  /** 排除 disabled/idle 后的监控数 */
  monitoredCount: number;
  /**
   * 分组 24h 请求加权可用性 0–100。
   * 无流量样本时 null。
   */
  uptime24h: number | null;
  requests24h: number;
  issues24h: number;
  issueRate24h: number | null;
  requests1h: number;
  issues1h: number;
  avgUseTimeSec24h: number | null;
  /** 分组内渠道测速的中位/最好（ms） */
  bestResponseTimeMs: number | null;
  lastRequestAt: string | null;
  /** 分组合成心跳：各小时请求/问题求和后再 tonemap */
  heartbeats: ChannelHeartbeatBucket[];
  /** 该分组下渠道（已按健康度排序） */
  channels: ChannelHealthRow[];
  /** 分组整体状态：取组内最差故障档；全静默/闲置单独标 */
  health: ChannelHealthLevel;
}

export interface ChannelIssueSample {
  at: string;
  model: string;
  content: string;
  useTimeSec: number | null;
  quota: number;
  username: string;
}

export interface ChannelModelBreakdown {
  model: string;
  requests: number;
  issues: number;
  issueRate: number | null;
  quota: number;
  avgUseTimeSec: number | null;
}

export interface ChannelHealthDetail {
  siteId: string;
  siteName: string;
  channel: ChannelHealthRow;
  recentIssues: ChannelIssueSample[];
  models24h: ChannelModelBreakdown[];
}

interface ChannelRow {
  id: number;
  type: number;
  name: string;
  status: number;
  weight: number;
  priority: number;
  response_time: number | null;
  test_time: number | null;
  balance: number | null;
  models: string;
  group: string;
  used_quota: number;
  auto_ban: number;
  tag: string;
  remark: string;
}

interface AggRow {
  channel_id: number;
  r1h: number;
  i1h: number;
  q1h: number;
  avg1h: number | null;
  max1h: number | null;
  last1h: number | null;
  r2h: number;
  i2h: number;
  q2h: number;
  avg2h: number | null;
  max2h: number | null;
  last2h: number | null;
  r1d: number;
  i1d: number;
  q1d: number;
  avg1d: number | null;
  max1d: number | null;
  last1d: number | null;
  r7d: number;
  i7d: number;
  q7d: number;
  avg7d: number | null;
  max7d: number | null;
  last7d: number | null;
}

interface HourAgg {
  requests: number;
  issues: number;
  avgUseTimeSec: number | null;
}

function emptySummary(): ChannelHealthSummary {
  return {
    total: 0,
    statusEnabled: 0,
    statusDisabled: 0,
    critical: 0,
    degraded: 0,
    silent: 0,
    disabled: 0,
    idle: 0,
    healthy: 0,
    uptime24h: null,
    upCount: 0,
    downCount: 0,
    monitoredCount: 0,
  };
}

function addSummary(a: ChannelHealthSummary, b: ChannelHealthSummary): ChannelHealthSummary {
  // uptime 需要按请求量重算，这里先拼计数，外层再用 rows 重算
  return {
    total: a.total + b.total,
    statusEnabled: a.statusEnabled + b.statusEnabled,
    statusDisabled: a.statusDisabled + b.statusDisabled,
    critical: a.critical + b.critical,
    degraded: a.degraded + b.degraded,
    silent: a.silent + b.silent,
    disabled: a.disabled + b.disabled,
    idle: a.idle + b.idle,
    healthy: a.healthy + b.healthy,
    uptime24h: null,
    upCount: a.upCount + b.upCount,
    downCount: a.downCount + b.downCount,
    monitoredCount: a.monitoredCount + b.monitoredCount,
  };
}

function tallySummary(rows: ChannelHealthRow[]): ChannelHealthSummary {
  const s = emptySummary();
  s.total = rows.length;
  let req = 0;
  let ok = 0;
  for (const r of rows) {
    if (r.enabled) s.statusEnabled++;
    else s.statusDisabled++;
    s[r.health]++;
    if (r.health === "healthy") s.upCount++;
    // 静默 = 启用但近期无流量，提示关注即可，不计入异常
    if (r.health === "critical" || r.health === "degraded") {
      s.downCount++;
    }
    if (r.health !== "disabled" && r.health !== "idle") {
      s.monitoredCount++;
      if (r.d1.requests > 0) {
        req += r.d1.requests;
        ok += Math.max(0, r.d1.requests - r.d1.issues);
      }
    }
  }
  if (req > 0) {
    s.uptime24h = Math.round((ok / req) * 10000) / 100;
  }
  return s;
}

function unixToIso(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const d = new Date(sec * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function quotaToUsd(quota: number, qpd: number): number {
  if (!qpd) return 0;
  return Math.round(((quota || 0) / qpd) * 1e6) / 1e6;
}

function issueRate(issues: number, requests: number): number | null {
  if (requests <= 0) return null;
  return Math.round((issues / requests) * 10000) / 10000;
}

function windowStats(
  requests: number,
  issues: number,
  quota: number,
  avg: number | null,
  max: number | null,
  last: number | null,
  qpd: number,
): ChannelWindowStats {
  return {
    requests: requests || 0,
    issues: issues || 0,
    issueRate: issueRate(issues || 0, requests || 0),
    quota: quota || 0,
    quotaUsd: quotaToUsd(quota || 0, qpd),
    avgUseTimeSec:
      avg != null && Number.isFinite(avg) ? Math.round(avg * 10) / 10 : null,
    maxUseTimeSec:
      max != null && Number.isFinite(max) ? Math.round(max * 10) / 10 : null,
    lastRequestAt: unixToIso(last),
  };
}

function splitModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * content 非空且像故障文案，或消费日志 quota=0 却写了说明（上游超时等）。
 * 「模型测试」是主动测速，不算故障。
 */
const ISSUE_SQL = `(
  (
    content IS NOT NULL AND content != ''
    AND content != '模型测试'
    AND (
      content LIKE '%超时%'
      OR content LIKE '%失败%'
      OR content LIKE '%错误%'
      OR content LIKE '%无法%'
      OR content LIKE '%error%'
      OR content LIKE '%Error%'
      OR content LIKE '%timeout%'
      OR content LIKE '%Timeout%'
      OR content LIKE '%denied%'
      OR content LIKE '%invalid%'
      OR content LIKE '%rate limit%'
      OR content LIKE '%429%'
      OR content LIKE '%502%'
      OR content LIKE '%503%'
      OR content LIKE '%500%'
      OR (quota = 0 AND content NOT LIKE 'Logged in%')
    )
  )
)`;

async function tableExists(
  conn: mysql.Connection,
  name: string,
): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 AS ok
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     LIMIT 1`,
    [name],
  );
  return Boolean(rows?.[0]);
}

async function columnSet(
  conn: mysql.Connection,
  table: string,
): Promise<Set<string>> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return new Set(
    (rows || []).map((r) =>
      String((r as { name?: string }).name || "").toLowerCase(),
    ),
  );
}

async function loadChannels(conn: mysql.Connection): Promise<ChannelRow[]> {
  if (!(await tableExists(conn, "channels"))) {
    throw new Error("库中无 channels 表");
  }
  const cols = await columnSet(conn, "channels");
  const need = ["id", "name", "status"];
  for (const c of need) {
    if (!cols.has(c)) throw new Error(`channels 表缺少列 ${c}`);
  }

  const pick = (name: string, alias?: string, fallbackSql?: string) => {
    if (cols.has(name)) {
      const ident = name === "group" ? "`group`" : name;
      return `${ident}${alias ? ` AS ${alias}` : ""}`;
    }
    return `${fallbackSql ?? "NULL"} AS ${alias || name}`;
  };

  const select = [
    "id",
    pick("type", "type", "0"),
    "name",
    "status",
    pick("weight", "weight", "0"),
    pick("priority", "priority", "0"),
    pick("response_time", "response_time"),
    pick("test_time", "test_time"),
    pick("balance", "balance"),
    pick("models", "models", "''"),
    pick("group", "group_name", "''"),
    pick("used_quota", "used_quota", "0"),
    pick("auto_ban", "auto_ban", "0"),
    pick("tag", "tag", "''"),
    pick("remark", "remark", "''"),
  ];

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${select.join(", ")} FROM channels ORDER BY id ASC`,
  );

  return (rows || []).map((r) => ({
    id: Number(r.id),
    type: Number(r.type) || 0,
    name: String(r.name || ""),
    status: Number(r.status) || 0,
    weight: Number(r.weight) || 0,
    priority: Number(r.priority) || 0,
    response_time:
      r.response_time == null || r.response_time === ""
        ? null
        : Number(r.response_time),
    test_time:
      r.test_time == null || r.test_time === "" ? null : Number(r.test_time),
    balance:
      r.balance == null || r.balance === "" ? null : Number(r.balance),
    models: typeof r.models === "string" ? r.models : String(r.models || ""),
    group:
      typeof r.group_name === "string"
        ? r.group_name
        : String(r.group_name || ""),
    used_quota: Number(r.used_quota) || 0,
    auto_ban: Number(r.auto_ban) || 0,
    tag: typeof r.tag === "string" ? r.tag : String(r.tag || ""),
    remark: typeof r.remark === "string" ? r.remark : String(r.remark || ""),
  }));
}

async function loadAggregates(
  conn: mysql.Connection,
  nowSec: number,
): Promise<Map<number, AggRow>> {
  const out = new Map<number, AggRow>();
  if (!(await tableExists(conn, "logs"))) return out;

  const cols = await columnSet(conn, "logs");
  // 你这套库是 channel_id；老 OneAPI 可能是 channel
  const channelCol = cols.has("channel_id")
    ? "channel_id"
    : cols.has("channel")
      ? "channel"
      : null;
  if (!channelCol || !cols.has("created_at") || !cols.has("type")) return out;

  const hasContent = cols.has("content");
  const hasQuota = cols.has("quota");
  const hasUseTime = cols.has("use_time");

  const issueExpr = hasContent ? `CASE WHEN ${ISSUE_SQL} THEN 1 ELSE 0 END` : "0";
  const quotaExpr = hasQuota ? "COALESCE(quota, 0)" : "0";
  const useExpr = hasUseTime ? "use_time" : "NULL";

  const t1h = nowSec - 3600;
  const t2h = nowSec - HEALTH_THRESHOLDS.silentHours * 3600;
  const t1d = nowSec - 86400;
  const t7d = nowSec - 7 * 86400;

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT
        \`${channelCol}\` AS channel_id,
        SUM(created_at >= ?) AS r1h,
        SUM(CASE WHEN created_at >= ? THEN ${issueExpr} ELSE 0 END) AS i1h,
        SUM(CASE WHEN created_at >= ? THEN ${quotaExpr} ELSE 0 END) AS q1h,
        AVG(CASE WHEN created_at >= ? THEN ${useExpr} END) AS avg1h,
        MAX(CASE WHEN created_at >= ? THEN ${useExpr} END) AS max1h,
        MAX(CASE WHEN created_at >= ? THEN created_at END) AS last1h,

        SUM(created_at >= ?) AS r2h,
        SUM(CASE WHEN created_at >= ? THEN ${issueExpr} ELSE 0 END) AS i2h,
        SUM(CASE WHEN created_at >= ? THEN ${quotaExpr} ELSE 0 END) AS q2h,
        AVG(CASE WHEN created_at >= ? THEN ${useExpr} END) AS avg2h,
        MAX(CASE WHEN created_at >= ? THEN ${useExpr} END) AS max2h,
        MAX(CASE WHEN created_at >= ? THEN created_at END) AS last2h,

        SUM(created_at >= ?) AS r1d,
        SUM(CASE WHEN created_at >= ? THEN ${issueExpr} ELSE 0 END) AS i1d,
        SUM(CASE WHEN created_at >= ? THEN ${quotaExpr} ELSE 0 END) AS q1d,
        AVG(CASE WHEN created_at >= ? THEN ${useExpr} END) AS avg1d,
        MAX(CASE WHEN created_at >= ? THEN ${useExpr} END) AS max1d,
        MAX(CASE WHEN created_at >= ? THEN created_at END) AS last1d,

        COUNT(*) AS r7d,
        SUM(${issueExpr}) AS i7d,
        SUM(${quotaExpr}) AS q7d,
        AVG(${useExpr}) AS avg7d,
        MAX(${useExpr}) AS max7d,
        MAX(created_at) AS last7d
     FROM logs
     WHERE type = ?
       AND created_at >= ?
       AND \`${channelCol}\` IS NOT NULL
       AND \`${channelCol}\` > 0
     GROUP BY \`${channelCol}\``,
    [
      t1h,
      t1h,
      t1h,
      t1h,
      t1h,
      t1h,
      t2h,
      t2h,
      t2h,
      t2h,
      t2h,
      t2h,
      t1d,
      t1d,
      t1d,
      t1d,
      t1d,
      t1d,
      LOG_TYPE_CONSUME,
      t7d,
    ],
  );

  for (const r of rows || []) {
    const id = Number(r.channel_id);
    if (!Number.isFinite(id)) continue;
    out.set(id, {
      channel_id: id,
      r1h: Number(r.r1h) || 0,
      i1h: Number(r.i1h) || 0,
      q1h: Number(r.q1h) || 0,
      avg1h: r.avg1h == null ? null : Number(r.avg1h),
      max1h: r.max1h == null ? null : Number(r.max1h),
      last1h: r.last1h == null ? null : Number(r.last1h),
      r2h: Number(r.r2h) || 0,
      i2h: Number(r.i2h) || 0,
      q2h: Number(r.q2h) || 0,
      avg2h: r.avg2h == null ? null : Number(r.avg2h),
      max2h: r.max2h == null ? null : Number(r.max2h),
      last2h: r.last2h == null ? null : Number(r.last2h),
      r1d: Number(r.r1d) || 0,
      i1d: Number(r.i1d) || 0,
      q1d: Number(r.q1d) || 0,
      avg1d: r.avg1d == null ? null : Number(r.avg1d),
      max1d: r.max1d == null ? null : Number(r.max1d),
      last1d: r.last1d == null ? null : Number(r.last1d),
      r7d: Number(r.r7d) || 0,
      i7d: Number(r.i7d) || 0,
      q7d: Number(r.q7d) || 0,
      avg7d: r.avg7d == null ? null : Number(r.avg7d),
      max7d: r.max7d == null ? null : Number(r.max7d),
      last7d: r.last7d == null ? null : Number(r.last7d),
    });
  }
  return out;
}

function hourBucketStartSec(nowSec: number, hoursAgo: number): number {
  // 对齐到整点（UTC）；展示时再转本地。心跳格用 UTC 整点即可稳定拼接。
  const currentHour = Math.floor(nowSec / 3600) * 3600;
  return currentHour - hoursAgo * 3600;
}

function heartbeatTone(
  requests: number,
  issues: number,
  enabled: boolean,
): HeartbeatTone {
  if (!enabled) return "empty";
  if (requests <= 0) return "pending";
  const rate = issues / requests;
  if (rate >= HEALTH_THRESHOLDS.issueRateCritical) return "down";
  if (rate >= HEALTH_THRESHOLDS.issueRateDegraded) return "degraded";
  // 样本很少但全是问题
  if (issues > 0 && requests < HEALTH_THRESHOLDS.minRequestsForRate && rate >= 0.5) {
    return "degraded";
  }
  return "up";
}

function buildHeartbeats(
  hourly: Map<number, HourAgg> | undefined,
  nowSec: number,
  enabled: boolean,
): ChannelHeartbeatBucket[] {
  const hours = HEALTH_THRESHOLDS.heartbeatHours;
  const out: ChannelHeartbeatBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const start = hourBucketStartSec(nowSec, i);
    const hit = hourly?.get(start);
    const requests = hit?.requests || 0;
    const issues = hit?.issues || 0;
    const d = new Date(start * 1000);
    const label = `${String(d.getHours()).padStart(2, "0")}:00`;
    out.push({
      hourStart: unixToIso(start) || new Date(start * 1000).toISOString(),
      label,
      requests,
      issues,
      issueRate: issueRate(issues, requests),
      avgUseTimeSec: hit?.avgUseTimeSec ?? null,
      tone: heartbeatTone(requests, issues, enabled),
    });
  }
  return out;
}

/**
 * 按 channel × UTC 整点小时聚合近 heartbeatHours 的请求/问题。
 * key = channelId → (hourStartSec → HourAgg)
 */
async function loadHourlyHeartbeats(
  conn: mysql.Connection,
  nowSec: number,
): Promise<Map<number, Map<number, HourAgg>>> {
  const out = new Map<number, Map<number, HourAgg>>();
  if (!(await tableExists(conn, "logs"))) return out;

  const cols = await columnSet(conn, "logs");
  const channelCol = cols.has("channel_id")
    ? "channel_id"
    : cols.has("channel")
      ? "channel"
      : null;
  if (!channelCol || !cols.has("created_at") || !cols.has("type")) return out;

  const hasContent = cols.has("content");
  const hasUseTime = cols.has("use_time");
  const issueExpr = hasContent
    ? `SUM(CASE WHEN ${ISSUE_SQL} THEN 1 ELSE 0 END)`
    : "0";
  const useExpr = hasUseTime ? "AVG(use_time)" : "NULL";

  const hours = HEALTH_THRESHOLDS.heartbeatHours;
  // 多取 1 小时边界，避免整点切分漏边
  const rangeStart = hourBucketStartSec(nowSec, hours - 1);

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT
        \`${channelCol}\` AS channel_id,
        FLOOR(created_at / 3600) * 3600 AS hour_start,
        COUNT(*) AS requests,
        ${issueExpr} AS issues,
        ${useExpr} AS avg_use
     FROM logs
     WHERE type = ?
       AND created_at >= ?
       AND created_at <= ?
       AND \`${channelCol}\` IS NOT NULL
       AND \`${channelCol}\` > 0
     GROUP BY \`${channelCol}\`, hour_start`,
    [LOG_TYPE_CONSUME, rangeStart, nowSec],
  );

  for (const r of rows || []) {
    const id = Number(r.channel_id);
    const hourStart = Number(r.hour_start);
    if (!Number.isFinite(id) || !Number.isFinite(hourStart)) continue;
    let m = out.get(id);
    if (!m) {
      m = new Map();
      out.set(id, m);
    }
    m.set(hourStart, {
      requests: Number(r.requests) || 0,
      issues: Number(r.issues) || 0,
      avgUseTimeSec:
        r.avg_use == null || r.avg_use === ""
          ? null
          : Math.round(Number(r.avg_use) * 10) / 10,
    });
  }
  return out;
}

function scoreChannel(
  ch: ChannelRow,
  agg: AggRow | undefined,
  hourly: Map<number, HourAgg> | undefined,
  nowSec: number,
  qpd: number,
  siteId: string,
  siteName: string,
): ChannelHealthRow {
  const empty = {
    channel_id: ch.id,
    r1h: 0,
    i1h: 0,
    q1h: 0,
    avg1h: null,
    max1h: null,
    last1h: null,
    r2h: 0,
    i2h: 0,
    q2h: 0,
    avg2h: null,
    max2h: null,
    last2h: null,
    r1d: 0,
    i1d: 0,
    q1d: 0,
    avg1d: null,
    max1d: null,
    last1d: null,
    r7d: 0,
    i7d: 0,
    q7d: 0,
    avg7d: null,
    max7d: null,
    last7d: null,
  };
  const a = agg || empty;

  const h1 = windowStats(a.r1h, a.i1h, a.q1h, a.avg1h, a.max1h, a.last1h, qpd);
  const h2 = windowStats(a.r2h, a.i2h, a.q2h, a.avg2h, a.max2h, a.last2h, qpd);
  const d1 = windowStats(a.r1d, a.i1d, a.q1d, a.avg1d, a.max1d, a.last1d, qpd);
  const d7 = windowStats(a.r7d, a.i7d, a.q7d, a.avg7d, a.max7d, a.last7d, qpd);

  const enabled = ch.status === CHANNEL_STATUS_ENABLED;
  const responseTimeMs =
    ch.response_time != null &&
    Number.isFinite(ch.response_time) &&
    ch.response_time > 0
      ? ch.response_time
      : null;

  const models = splitModels(ch.models);
  const reasons: string[] = [];
  let health: ChannelHealthLevel = "healthy";

  const rateFor = (w: ChannelWindowStats) =>
    w.requests >= HEALTH_THRESHOLDS.minRequestsForRate ? w.issueRate : null;

  // 1h / 24h 都够样本时取更差的，避免「这一小时刚好正常」盖住整天故障
  const rate1h = rateFor(h1);
  const rate1d = rateFor(d1);
  let primaryRate: number | null = null;
  let primaryIssues = d1;
  let primaryLabel = "24h";
  if (rate1h != null && rate1d != null) {
    if (rate1h >= rate1d) {
      primaryRate = rate1h;
      primaryIssues = h1;
      primaryLabel = "1h";
    } else {
      primaryRate = rate1d;
      primaryIssues = d1;
      primaryLabel = "24h";
    }
  } else if (rate1h != null) {
    primaryRate = rate1h;
    primaryIssues = h1;
    primaryLabel = "1h";
  } else if (rate1d != null) {
    primaryRate = rate1d;
    primaryIssues = d1;
    primaryLabel = "24h";
  }

  if (!enabled) {
    health = "disabled";
    reasons.push(ch.status === 2 ? "已禁用" : `状态码 ${ch.status}`);
  } else {
    if (
      primaryRate != null &&
      primaryRate >= HEALTH_THRESHOLDS.issueRateCritical
    ) {
      health = "critical";
      reasons.push(
        `${primaryLabel} 问题率 ${(primaryRate * 100).toFixed(1)}%（${primaryIssues.issues}/${primaryIssues.requests}）`,
      );
    } else if (
      responseTimeMs != null &&
      responseTimeMs >= HEALTH_THRESHOLDS.responseTimeCriticalMs
    ) {
      health = "critical";
      reasons.push(`测速 ${(responseTimeMs / 1000).toFixed(1)}s`);
    } else if (
      primaryRate != null &&
      primaryRate >= HEALTH_THRESHOLDS.issueRateDegraded
    ) {
      health = "degraded";
      reasons.push(
        `${primaryLabel} 问题率 ${(primaryRate * 100).toFixed(1)}%（${primaryIssues.issues}/${primaryIssues.requests}）`,
      );
    } else if (
      responseTimeMs != null &&
      responseTimeMs >= HEALTH_THRESHOLDS.responseTimeSlowMs
    ) {
      health = "degraded";
      reasons.push(`测速偏慢 ${(responseTimeMs / 1000).toFixed(1)}s`);
    } else if (
      (h1.avgUseTimeSec != null &&
        h1.avgUseTimeSec >= HEALTH_THRESHOLDS.avgUseTimeSlowSec &&
        h1.requests >= HEALTH_THRESHOLDS.minRequestsForRate) ||
      (d1.avgUseTimeSec != null &&
        d1.avgUseTimeSec >= HEALTH_THRESHOLDS.avgUseTimeSlowSec &&
        d1.requests >= HEALTH_THRESHOLDS.minRequestsForRate)
    ) {
      health = "degraded";
      const sec = h1.avgUseTimeSec ?? d1.avgUseTimeSec;
      reasons.push(`平均耗时 ${sec}s`);
    } else if (
      d7.requests >= HEALTH_THRESHOLDS.silentMin7dRequests &&
      h2.requests === 0
    ) {
      health = "silent";
      reasons.push(
        `近 ${HEALTH_THRESHOLDS.silentHours}h 无请求（7 天 ${d7.requests} 次）`,
      );
    } else if (d7.requests === 0) {
      health = "idle";
      reasons.push("近 7 天无消费日志");
    }
  }

  if (
    enabled &&
    primaryRate != null &&
    primaryRate > 0 &&
    primaryRate < HEALTH_THRESHOLDS.issueRateDegraded &&
    health === "healthy"
  ) {
    reasons.push(
      `${primaryLabel} 偶发问题 ${(primaryRate * 100).toFixed(1)}%（${primaryIssues.issues}/${primaryIssues.requests}）`,
    );
  }

  if (health === "healthy" && reasons.length === 0) {
    if (h1.requests > 0) reasons.push(`近 1h ${h1.requests} 次正常`);
    else if (d1.requests > 0) reasons.push(`近 24h ${d1.requests} 次`);
    else reasons.push("启用中");
  }

  const uptime24h =
    d1.requests > 0
      ? Math.round(
          (Math.max(0, d1.requests - d1.issues) / d1.requests) * 10000,
        ) / 100
      : null;

  return {
    siteId,
    siteName,
    channelId: ch.id,
    name: ch.name || `#${ch.id}`,
    status: ch.status,
    enabled,
    group: ch.group || "",
    tag: ch.tag || "",
    priority: ch.priority,
    weight: ch.weight,
    type: ch.type,
    models,
    modelCount: models.length,
    responseTimeMs,
    testAt: unixToIso(ch.test_time),
    balance: ch.balance,
    usedQuota: ch.used_quota,
    usedQuotaUsd: quotaToUsd(ch.used_quota, qpd),
    autoBan: ch.auto_ban === 1,
    remark: ch.remark || "",
    health,
    reasons,
    uptime24h,
    heartbeats: buildHeartbeats(hourly, nowSec, enabled),
    h1,
    h2,
    d1,
    d7,
  };
}

const HEALTH_SORT: Record<ChannelHealthLevel, number> = {
  critical: 0,
  degraded: 1,
  silent: 2,
  disabled: 3,
  idle: 4,
  healthy: 5,
};

function sortChannels(rows: ChannelHealthRow[]): ChannelHealthRow[] {
  return [...rows].sort((a, b) => {
    const hs = HEALTH_SORT[a.health] - HEALTH_SORT[b.health];
    if (hs !== 0) return hs;
    // 同档：问题多的、流量大的在前
    const ir =
      (b.d1.issueRate ?? -1) - (a.d1.issueRate ?? -1);
    if (ir !== 0) return ir;
    if (b.d1.requests !== a.d1.requests) return b.d1.requests - a.d1.requests;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.channelId - b.channelId;
  });
}

function groupLabel(group: string): string {
  const g = group.trim();
  return g || "未分组";
}

function mergeHeartbeats(
  channels: ChannelHealthRow[],
): ChannelHeartbeatBucket[] {
  if (channels.length === 0) return [];
  const hours = channels[0]?.heartbeats?.length || HEALTH_THRESHOLDS.heartbeatHours;
  const out: ChannelHeartbeatBucket[] = [];
  for (let i = 0; i < hours; i++) {
    let requests = 0;
    let issues = 0;
    let useSum = 0;
    let useN = 0;
    let hourStart = "";
    let label = "";
    let anyEnabled = false;
    for (const ch of channels) {
      const b = ch.heartbeats[i];
      if (!b) continue;
      hourStart = hourStart || b.hourStart;
      label = label || b.label;
      requests += b.requests;
      issues += b.issues;
      if (b.avgUseTimeSec != null && b.requests > 0) {
        useSum += b.avgUseTimeSec * b.requests;
        useN += b.requests;
      }
      if (ch.enabled) anyEnabled = true;
    }
    out.push({
      hourStart,
      label,
      requests,
      issues,
      issueRate: issueRate(issues, requests),
      avgUseTimeSec:
        useN > 0 ? Math.round((useSum / useN) * 10) / 10 : null,
      tone: heartbeatTone(requests, issues, anyEnabled),
    });
  }
  return out;
}

function pickGroupHealth(rows: ChannelHealthRow[]): ChannelHealthLevel {
  if (rows.length === 0) return "idle";
  // 组状态取最差故障档；无故障时再看静默/闲置/禁用/健康
  let best = 99;
  let level: ChannelHealthLevel = "healthy";
  for (const r of rows) {
    const rank = HEALTH_SORT[r.health];
    if (rank < best) {
      best = rank;
      level = r.health;
    }
  }
  return level;
}

/** 按 site + group 聚合渠道 uptime */
export function aggregateGroups(channels: ChannelHealthRow[]): GroupUptimeRow[] {
  const map = new Map<string, ChannelHealthRow[]>();
  for (const ch of channels) {
    const key = `${ch.siteId}\0${ch.group || ""}`;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(ch);
  }

  const groups: GroupUptimeRow[] = [];
  for (const [key, list] of map) {
    const sorted = sortChannels(list);
    const head = sorted[0];
    const group = head.group || "";
    let enabledCount = 0;
    let disabledCount = 0;
    let healthy = 0;
    let degraded = 0;
    let critical = 0;
    let silent = 0;
    let idle = 0;
    let monitoredCount = 0;
    let requests24h = 0;
    let issues24h = 0;
    let requests1h = 0;
    let issues1h = 0;
    let useSum = 0;
    let useN = 0;
    let lastRequestAt: string | null = null;
    let bestResponseTimeMs: number | null = null;

    for (const r of sorted) {
      if (r.enabled) enabledCount++;
      else disabledCount++;
      if (r.health === "healthy") healthy++;
      else if (r.health === "degraded") degraded++;
      else if (r.health === "critical") critical++;
      else if (r.health === "silent") silent++;
      else if (r.health === "idle") idle++;
      // disabled 由 tally 的 s[r.health] 在渠道级处理；这里 disabledCount 已覆盖

      if (r.health !== "disabled" && r.health !== "idle") monitoredCount++;

      requests24h += r.d1.requests;
      issues24h += r.d1.issues;
      requests1h += r.h1.requests;
      issues1h += r.h1.issues;
      if (r.d1.avgUseTimeSec != null && r.d1.requests > 0) {
        useSum += r.d1.avgUseTimeSec * r.d1.requests;
        useN += r.d1.requests;
      }
      const lr = r.d7.lastRequestAt || r.d1.lastRequestAt;
      if (lr && (!lastRequestAt || lr > lastRequestAt)) lastRequestAt = lr;
      if (
        r.responseTimeMs != null &&
        r.responseTimeMs > 0 &&
        (bestResponseTimeMs == null || r.responseTimeMs < bestResponseTimeMs)
      ) {
        bestResponseTimeMs = r.responseTimeMs;
      }
    }

    const uptime24h =
      requests24h > 0
        ? Math.round(
            (Math.max(0, requests24h - issues24h) / requests24h) * 10000,
          ) / 100
        : null;

    groups.push({
      key: key.replace("\0", ":"),
      siteId: head.siteId,
      siteName: head.siteName,
      group,
      label: groupLabel(group),
      channelCount: sorted.length,
      enabledCount,
      disabledCount,
      healthy,
      degraded,
      critical,
      silent,
      idle,
      downCount: critical + degraded,
      monitoredCount,
      uptime24h,
      requests24h,
      issues24h,
      issueRate24h: issueRate(issues24h, requests24h),
      requests1h,
      issues1h,
      avgUseTimeSec24h:
        useN > 0 ? Math.round((useSum / useN) * 10) / 10 : null,
      bestResponseTimeMs,
      lastRequestAt,
      heartbeats: mergeHeartbeats(sorted),
      channels: sorted,
      health: pickGroupHealth(sorted),
    });
  }

  return groups.sort((a, b) => {
    const hs = HEALTH_SORT[a.health] - HEALTH_SORT[b.health];
    if (hs !== 0) return hs;
    const ua = a.uptime24h ?? 101;
    const ub = b.uptime24h ?? 101;
    if (ua !== ub) return ua - ub;
    if (b.requests24h !== a.requests24h) return b.requests24h - a.requests24h;
    return a.label.localeCompare(b.label, "zh-CN");
  });
}

async function fetchSiteHealth(input: {
  siteId: string;
  siteName: string;
  enabled: boolean;
  dbDsn: string | null;
  quotaPerDollar: number;
}): Promise<ChannelHealthSiteResult> {
  const base: ChannelHealthSiteResult = {
    siteId: input.siteId,
    siteName: input.siteName,
    enabled: input.enabled,
    dbBound: Boolean(input.dbDsn),
    ok: false,
    summary: emptySummary(),
    channels: [],
  };

  if (!input.dbDsn) {
    return { ...base, error: "未绑定数据库，无法监控渠道" };
  }
  const plain = decryptSecret(input.dbDsn);
  if (!plain) {
    return {
      ...base,
      error: "DSN 无法解密（ENCRYPTION_SECRET 是否更换过？）",
    };
  }

  const started = Date.now();
  try {
    const channels = await withNewApiDb(plain, async (conn) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const [list, agg, hourly] = await Promise.all([
        loadChannels(conn),
        loadAggregates(conn, nowSec),
        loadHourlyHeartbeats(conn, nowSec),
      ]);
      const qpd = input.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
      return list.map((ch) =>
        scoreChannel(
          ch,
          agg.get(ch.id),
          hourly.get(ch.id),
          nowSec,
          qpd,
          input.siteId,
          input.siteName,
        ),
      );
    });

    const sorted = sortChannels(channels);
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      fetchedAt: new Date().toISOString(),
      summary: tallySummary(sorted),
      channels: sorted,
    };
  } catch (e) {
    return {
      ...base,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function getChannelHealth(opts?: {
  siteId?: string;
}): Promise<ChannelHealthPayload> {
  const sites = await prisma.downstreamSite.findMany({
    where: opts?.siteId ? { id: opts.siteId } : undefined,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      enabled: true,
      dbDsn: true,
      quotaPerDollar: true,
    },
  });

  const results: ChannelHealthSiteResult[] = [];
  // 串行查各站，避免同时打爆多台远端 MySQL
  for (const s of sites) {
    results.push(
      await fetchSiteHealth({
        siteId: s.id,
        siteName: s.name,
        enabled: s.enabled,
        dbDsn: s.dbDsn,
        quotaPerDollar: s.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR,
      }),
    );
  }

  const channels = sortChannels(results.flatMap((r) => r.channels));
  // 跨站 summary 的 uptime 需按全量 channels 重算，不能只加 downCount
  const summary = tallySummary(channels);
  const groups = aggregateGroups(channels);

  return {
    fetchedAt: new Date().toISOString(),
    thresholds: HEALTH_THRESHOLDS,
    sites: results,
    summary,
    channels,
    groups,
  };
}

export async function getChannelHealthDetail(input: {
  siteId: string;
  channelId: number;
}): Promise<ChannelHealthDetail> {
  const site = await prisma.downstreamSite.findUnique({
    where: { id: input.siteId },
    select: {
      id: true,
      name: true,
      enabled: true,
      dbDsn: true,
      quotaPerDollar: true,
    },
  });
  if (!site) throw new Error("站点不存在");
  if (!site.dbDsn) throw new Error("未绑定数据库");

  const plain = decryptSecret(site.dbDsn);
  if (!plain) throw new Error("DSN 无法解密");

  const qpd = site.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const siteHealth = await fetchSiteHealth({
    siteId: site.id,
    siteName: site.name,
    enabled: site.enabled,
    dbDsn: site.dbDsn,
    quotaPerDollar: qpd,
  });
  if (!siteHealth.ok) {
    throw new Error(siteHealth.error || "读取站点失败");
  }
  const channel = siteHealth.channels.find(
    (c) => c.channelId === input.channelId,
  );
  if (!channel) throw new Error("渠道不存在或已删除");

  const detail = await withNewApiDb(plain, async (conn) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const t1d = nowSec - 86400;
    const cols = await columnSet(conn, "logs");
    const channelCol = cols.has("channel_id")
      ? "channel_id"
      : cols.has("channel")
        ? "channel"
        : null;
    if (!channelCol) {
      return { recentIssues: [] as ChannelIssueSample[], models24h: [] as ChannelModelBreakdown[] };
    }

    const hasContent = cols.has("content");
    const hasModel = cols.has("model_name");
    const hasUse = cols.has("use_time");
    const hasUser = cols.has("username");
    const hasQuota = cols.has("quota");

    let recentIssues: ChannelIssueSample[] = [];
    if (hasContent) {
      const [issueRows] = await conn.query<RowDataPacket[]>(
        `SELECT created_at,
                ${hasModel ? "model_name" : "'' AS model_name"},
                ${hasContent ? "content" : "'' AS content"},
                ${hasUse ? "use_time" : "NULL AS use_time"},
                ${hasQuota ? "quota" : "0 AS quota"},
                ${hasUser ? "username" : "'' AS username"}
         FROM logs
         WHERE type = ?
           AND \`${channelCol}\` = ?
           AND created_at >= ?
           AND ${ISSUE_SQL}
         ORDER BY created_at DESC
         LIMIT ?`,
        [
          LOG_TYPE_CONSUME,
          input.channelId,
          nowSec - 7 * 86400,
          HEALTH_THRESHOLDS.recentIssueLimit,
        ],
      );
      recentIssues = (issueRows || []).map((r) => ({
        at: unixToIso(Number(r.created_at)) || "",
        model: String(r.model_name || ""),
        content: String(r.content || "").slice(0, 240),
        useTimeSec:
          r.use_time == null || r.use_time === ""
            ? null
            : Number(r.use_time),
        quota: Number(r.quota) || 0,
        username: String(r.username || ""),
      }));
    }

    let models24h: ChannelModelBreakdown[] = [];
    if (hasModel) {
      const issueExpr = hasContent
        ? `SUM(CASE WHEN ${ISSUE_SQL} THEN 1 ELSE 0 END)`
        : "0";
      const [modelRows] = await conn.query<RowDataPacket[]>(
        `SELECT
            COALESCE(NULLIF(model_name, ''), '(unknown)') AS model,
            COUNT(*) AS requests,
            ${issueExpr} AS issues,
            ${hasQuota ? "COALESCE(SUM(quota),0)" : "0"} AS quota,
            ${hasUse ? "AVG(use_time)" : "NULL"} AS avg_use
         FROM logs
         WHERE type = ?
           AND \`${channelCol}\` = ?
           AND created_at >= ?
         GROUP BY COALESCE(NULLIF(model_name, ''), '(unknown)')
         ORDER BY requests DESC
         LIMIT ?`,
        [
          LOG_TYPE_CONSUME,
          input.channelId,
          t1d,
          HEALTH_THRESHOLDS.modelBreakdownLimit,
        ],
      );
      models24h = (modelRows || []).map((r) => {
        const requests = Number(r.requests) || 0;
        const issues = Number(r.issues) || 0;
        return {
          model: String(r.model || ""),
          requests,
          issues,
          issueRate: issueRate(issues, requests),
          quota: Number(r.quota) || 0,
          avgUseTimeSec:
            r.avg_use == null || r.avg_use === ""
              ? null
              : Math.round(Number(r.avg_use) * 10) / 10,
        };
      });
    }

    return { recentIssues, models24h };
  });

  return {
    siteId: site.id,
    siteName: site.name,
    channel,
    recentIssues: detail.recentIssues,
    models24h: detail.models24h,
  };
}
