/**
 * Read-only access to a bound NewAPI MySQL (same SQL_DSN as the site).
 * Short-lived connections only — no global pool across downstream sites.
 *
 * Tables (GORM defaults): users, logs, quota_data, top_ups, redemptions.
 * Consume logs: type = 2. Timestamps are unix seconds.
 */

import type { RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";
import {
  humanizeMysqlError,
  parseGoMysqlDsn,
  sslOptionFromParams,
} from "@/lib/newapi-dsn";
import { addDays, enumerateDays } from "@/lib/reporting-period";
import type {
  DownstreamDailyRow,
  DownstreamDailyUsageResult,
  DownstreamDailyUserUsageResult,
  DownstreamFetchResult,
  DownstreamGroupDailyRow,
  DownstreamModelDailyResult,
  DownstreamRedemptionResult,
  DownstreamTopupResult,
  DownstreamTopupSource,
  DownstreamUserListResult,
  DownstreamUserRow,
} from "@/lib/adapters/types";

const LOG_TYPE_CONSUME = 2;
const DEFAULT_QUOTA_PER_DOLLAR = 500_000;
const CONNECT_TIMEOUT_MS = 12_000;

export type NewApiTableName =
  | "users"
  | "logs"
  | "quota_data"
  | "top_ups"
  | "redemptions";

export interface NewApiDbTables {
  users: boolean;
  logs: boolean;
  quota_data: boolean;
  top_ups: boolean;
  redemptions: boolean;
}

function quotaToUsd(quota: number, quotaPerDollar: number): number {
  if (!quotaPerDollar) return 0;
  return quota / quotaPerDollar;
}

/** Asia/Shanghai calendar day → inclusive unix-second bounds (same as HTTP adapter). */
export function shanghaiDayBounds(day: string): { start: number; end: number } {
  const start = Math.floor(new Date(`${day}T00:00:00+08:00`).getTime() / 1000);
  const end =
    Math.floor(new Date(`${addDays(day, 1)}T00:00:00+08:00`).getTime() / 1000) - 1;
  return { start, end };
}

function unixSecondsToDate(seconds: number | null | undefined): Date | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeTopupSource(row: {
  source?: unknown;
  payment_method?: unknown;
  payment_provider?: unknown;
}): { source: DownstreamTopupSource; sourceRaw: string } {
  const rawCandidates = [row.source];
  const raw = rawCandidates.find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  const sourceRaw = raw?.trim().slice(0, 100) || "";
  const normalized = sourceRaw.toLowerCase().replace(/[\s-]+/g, "_");
  if (["admin", "admin_manual", "manual_admin", "manage_user"].includes(normalized)) {
    return { source: "ADMIN_MANUAL", sourceRaw };
  }
  if (
    ["redeem", "redeem_code", "redemption", "redemption_code"].includes(normalized)
  ) {
    return { source: "REDEEM_CODE", sourceRaw };
  }
  if (["website", "website_payment", "online_payment"].includes(normalized)) {
    return { source: "WEBSITE_PAYMENT", sourceRaw };
  }
  // Heuristic when top_ups has no source column
  const method = String(row.payment_method || "").toLowerCase();
  const provider = String(row.payment_provider || "").toLowerCase();
  if (!sourceRaw && (method || provider)) {
    if (method.includes("admin") || provider.includes("admin")) {
      return { source: "ADMIN_MANUAL", sourceRaw: method || provider };
    }
    if (method.includes("redeem") || provider.includes("redeem")) {
      return { source: "REDEEM_CODE", sourceRaw: method || provider };
    }
    if (method || provider) {
      return {
        source: "WEBSITE_PAYMENT",
        sourceRaw: (method || provider).slice(0, 100),
      };
    }
  }
  return { source: "UNKNOWN", sourceRaw };
}

async function createConnection(plainDsn: string): Promise<mysql.Connection> {
  const parsed = parseGoMysqlDsn(plainDsn);
  const ssl = sslOptionFromParams(parsed.params);
  return mysql.createConnection({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    multipleStatements: false,
    dateStrings: true,
    ...(ssl !== undefined ? { ssl } : {}),
  });
}

/**
 * Open one connection, run work, always close.
 * `plainDsn` must already be decrypted.
 */
export async function withNewApiDb<T>(
  plainDsn: string,
  fn: (conn: mysql.Connection) => Promise<T>,
): Promise<T> {
  let conn: mysql.Connection | null = null;
  try {
    conn = await createConnection(plainDsn);
    return await fn(conn);
  } catch (e) {
    const msg = humanizeMysqlError(e);
    throw new Error(msg);
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function detectNewApiTables(
  conn: mysql.Connection,
): Promise<NewApiDbTables> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('users','logs','quota_data','top_ups','redemptions')`,
  );
  const names = new Set(
    (rows || []).map((r) => String((r as { name?: string }).name || "").toLowerCase()),
  );
  return {
    users: names.has("users"),
    logs: names.has("logs"),
    quota_data: names.has("quota_data"),
    top_ups: names.has("top_ups"),
    redemptions: names.has("redemptions"),
  };
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
    (rows || []).map((r) => String((r as { name?: string }).name || "").toLowerCase()),
  );
}

/**
 * Site overview numbers (same meaning as HTTP fetchDownstreamStats):
 * - consumed: last 30d consume logs (type=2) as face-value units
 * - revenue: issued credit of non-admin / non-excluded users as face-value units
 */
export async function dbFetchStats(
  conn: mysql.Connection,
  opts: {
    quotaPerDollar?: number;
    excludeUserIds?: number[];
    revenueCurrency?: "CNY" | "USD";
  } = {},
): Promise<DownstreamFetchResult> {
  const quotaPerDollar = opts.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const excludeSet = new Set(
    (opts.excludeUserIds || []).map(Number).filter((n) => Number.isFinite(n)),
  );
  const revenueCurrency = opts.revenueCurrency === "USD" ? "USD" : "CNY";

  const tables = await detectNewApiTables(conn);
  if (!tables.users && !tables.logs) {
    return {
      success: false,
      consumed: 0,
      revenue: 0,
      revenueCurrency,
      error: "库中无 users / logs 表",
    };
  }

  let consumed = 0;
  let revenue = 0;
  let usersSummary: Record<string, unknown> | null = null;
  let logsSummary: Record<string, unknown> | null = null;

  if (tables.logs) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 30 * 24 * 3600;
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(quota), 0) AS quota, COUNT(*) AS requests
       FROM logs
       WHERE type = ? AND created_at >= ? AND created_at <= ?`,
      [LOG_TYPE_CONSUME, start, now],
    );
    const quota = Number(rows?.[0]?.quota) || 0;
    const requests = Number(rows?.[0]?.requests) || 0;
    consumed = quotaToUsd(quota, quotaPerDollar);
    logsSummary = { windowDays: 30, quota, requests, consumed };
  }

  if (tables.users) {
    const users = await dbListUsers(conn, {
      quotaPerDollar,
      excludeUserIds: [...excludeSet],
    });
    if (!users.success) {
      return {
        success: false,
        consumed,
        revenue: 0,
        revenueCurrency,
        error: users.error || "读取 users 失败",
      };
    }
    let issuedQuota = 0;
    let usedQuota = 0;
    let countedUsers = 0;
    let excludedUsers = 0;
    let excludedIssued = 0;
    for (const u of users.users) {
      const issued = (Number(u.quota) || 0) + (Number(u.used_quota) || 0);
      if (u.excluded || u.role >= 100) {
        excludedUsers++;
        excludedIssued += issued;
        continue;
      }
      issuedQuota += issued;
      usedQuota += Number(u.used_quota) || 0;
      countedUsers++;
    }
    revenue = quotaToUsd(issuedQuota, quotaPerDollar);
    if (consumed === 0 && usedQuota > 0) {
      consumed = quotaToUsd(usedQuota, quotaPerDollar);
    }
    usersSummary = {
      issuedQuota,
      usedQuota,
      countedUsers,
      excludedUsers,
      excludedIssuedQuota: excludedIssued,
      excludeUserIds: [...excludeSet],
    };
  }

  return {
    success: true,
    consumed,
    revenue,
    revenueCurrency,
    raw: {
      source: "db",
      logs: logsSummary,
      users_summary: usersSummary,
    },
  };
}

export async function dbListUsers(
  conn: mysql.Connection,
  opts: {
    quotaPerDollar?: number;
    excludeUserIds?: number[];
    privateUserIds?: number[];
  } = {},
): Promise<DownstreamUserListResult> {
  const quotaPerDollar = opts.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const excludeSet = new Set(
    (opts.excludeUserIds || []).map(Number).filter((n) => Number.isFinite(n)),
  );
  const privateSet = new Set(
    (opts.privateUserIds || []).map(Number).filter((n) => Number.isFinite(n)),
  );

  const cols = await columnSet(conn, "users");
  if (!cols.has("id") || !cols.has("username")) {
    return {
      success: false,
      users: [],
      scanned: 0,
      total: 0,
      complete: false,
      error: "users 表缺少必要列",
    };
  }

  const select: string[] = [
    "id",
    "username",
    cols.has("display_name") ? "display_name" : "'' AS display_name",
    cols.has("role") ? "role" : "0 AS role",
    cols.has("status") ? "status" : "NULL AS status",
    cols.has("email") ? "email" : "NULL AS email",
    cols.has("quota") ? "quota" : "0 AS quota",
    cols.has("used_quota") ? "used_quota" : "0 AS used_quota",
    cols.has("request_count") ? "request_count" : "NULL AS request_count",
  ];
  const where = cols.has("deleted_at") ? "WHERE deleted_at IS NULL" : "";
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${select.join(", ")} FROM users ${where}`,
  );

  const users: DownstreamUserRow[] = [];
  for (const r of rows || []) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const quota = Number(r.quota) || 0;
    const used = Number(r.used_quota) || 0;
    const role = Number(r.role) || 0;
    const autoExcluded = role >= 100;
    users.push({
      id,
      username: String(r.username || ""),
      display_name:
        typeof r.display_name === "string" ? r.display_name : undefined,
      role,
      status:
        r.status == null || r.status === ""
          ? undefined
          : Number(r.status),
      email: typeof r.email === "string" ? r.email : undefined,
      quota,
      used_quota: used,
      issuedUsd: quotaToUsd(quota + used, quotaPerDollar),
      usedUsd: quotaToUsd(used, quotaPerDollar),
      request_count:
        r.request_count == null || r.request_count === ""
          ? undefined
          : Number(r.request_count),
      excluded: autoExcluded || excludeSet.has(id),
      isPrivate: !autoExcluded && !excludeSet.has(id) && privateSet.has(id),
    });
  }
  users.sort((a, b) => b.issuedUsd - a.issuedUsd);
  return {
    success: true,
    users,
    scanned: users.length,
    total: users.length,
    complete: true,
  };
}

type DayUserAgg = {
  day: string;
  username: string;
  quota: number;
  requests: number;
};

type DayTotalAgg = { day: string; quota: number; requests: number };
type DayGroupAgg = DownstreamGroupDailyRow;

/**
 * Asia/Shanghai calendar day as 'YYYY-MM-DD' from unix seconds.
 * Shanghai has no DST; offset is fixed +08:00.
 */
const SQL_SH_DAY = `DATE_FORMAT(CONVERT_TZ(FROM_UNIXTIME(created_at), '+00:00', '+08:00'), '%Y-%m-%d')`;

async function aggregateLogsByUserDay(
  conn: mysql.Connection,
  startDay: string,
  endDay: string,
): Promise<DayUserAgg[]> {
  const rangeStart = shanghaiDayBounds(startDay).start;
  const rangeEnd = shanghaiDayBounds(endDay).end;
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT username,
            ${SQL_SH_DAY} AS day,
            COALESCE(SUM(quota), 0) AS quota,
            COUNT(*) AS requests
     FROM logs
     WHERE type = ?
       AND created_at >= ?
       AND created_at <= ?
     GROUP BY username, day`,
    [LOG_TYPE_CONSUME, rangeStart, rangeEnd],
  );

  const out: DayUserAgg[] = [];
  for (const r of rows || []) {
    const day = String(r.day || "");
    if (!day || day < startDay || day > endDay) continue;
    const username = String(r.username || "");
    if (!username) continue;
    out.push({
      day,
      username,
      quota: Number(r.quota) || 0,
      requests: Number(r.requests) || 0,
    });
  }
  return out;
}

async function aggregateLogsDayTotals(
  conn: mysql.Connection,
  startDay: string,
  endDay: string,
): Promise<Map<string, DayTotalAgg>> {
  const rangeStart = shanghaiDayBounds(startDay).start;
  const rangeEnd = shanghaiDayBounds(endDay).end;
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${SQL_SH_DAY} AS day,
            COALESCE(SUM(quota), 0) AS quota,
            COUNT(*) AS requests
     FROM logs
     WHERE type = ?
       AND created_at >= ?
       AND created_at <= ?
     GROUP BY day`,
    [LOG_TYPE_CONSUME, rangeStart, rangeEnd],
  );
  const out = new Map<string, DayTotalAgg>();
  for (const r of rows || []) {
    const day = String(r.day || "");
    if (!day || day < startDay || day > endDay) continue;
    out.set(day, {
      day,
      quota: Number(r.quota) || 0,
      requests: Number(r.requests) || 0,
    });
  }
  return out;
}

async function aggregateLogsByGroupDay(
  conn: mysql.Connection,
  startDay: string,
  endDay: string,
): Promise<DayGroupAgg[]> {
  const cols = await columnSet(conn, "logs");
  if (!cols.has("group")) return [];

  const rangeStart = shanghaiDayBounds(startDay).start;
  const rangeEnd = shanghaiDayBounds(endDay).end;
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT \`group\` AS use_group,
            ${SQL_SH_DAY} AS day,
            COALESCE(SUM(quota), 0) AS quota,
            COUNT(*) AS requests
     FROM logs
     WHERE type = ?
       AND created_at >= ?
       AND created_at <= ?
     GROUP BY \`group\`, day`,
    [LOG_TYPE_CONSUME, rangeStart, rangeEnd],
  );
  const out: DayGroupAgg[] = [];
  for (const r of rows || []) {
    const day = String(r.day || "");
    if (!day || day < startDay || day > endDay) continue;
    out.push({
      day,
      groupName: String(r.use_group || ""),
      quota: Number(r.quota) || 0,
      requests: Number(r.requests) || 0,
    });
  }
  return out;
}

/**
 * Merge full-site day totals with per-user buckets (exclude / private).
 * Mirrors HTTP adapter scale+cap rules.
 */
export function buildDailyTotals(input: {
  days: string[];
  dayQuota: Map<string, DayTotalAgg>;
  perUserByDay: Map<
    string,
    { quota: number; excluded: number; private: number; requests: number }
  >;
  excludeSet: Set<string>;
  privateSet: Set<string>;
  /** true if we successfully loaded any per-user rows for the range */
  perUserAvailable: boolean;
}): { totals: DownstreamDailyRow[]; failedDays: string[] } {
  const {
    days,
    dayQuota,
    perUserByDay,
    excludeSet,
    privateSet,
    perUserAvailable,
  } = input;
  const failedDays: string[] = [];
  const totals: DownstreamDailyRow[] = [];

  for (const day of days) {
    const fromStat = dayQuota.get(day);
    const fromUsers = perUserByDay.get(day);
    const quota = fromStat?.quota ?? fromUsers?.quota;
    if (quota == null) {
      failedDays.push(day);
      continue;
    }

    const scale =
      fromUsers && fromUsers.quota > 0 && quota !== fromUsers.quota
        ? quota / fromUsers.quota
        : 1;

    let excludedQuota = 0;
    if (fromUsers && fromUsers.excluded > 0) {
      excludedQuota = fromUsers.excluded * scale;
      if (excludedQuota > quota) excludedQuota = quota;
    }

    let privateQuota = 0;
    if (fromUsers && fromUsers.private > 0) {
      privateQuota = fromUsers.private * scale;
      const payable = quota - excludedQuota;
      if (privateQuota > payable) privateQuota = payable;
    }

    totals.push({
      day,
      quota,
      excludedQuota,
      privateQuota,
      requests: fromUsers?.requests ?? fromStat?.requests ?? 0,
      excludeResolved:
        excludeSet.size === 0 || (perUserAvailable && fromUsers != null),
      privateResolved:
        privateSet.size === 0 || (perUserAvailable && fromUsers != null),
    });
  }

  return { totals, failedDays };
}

export async function dbFetchDailyUsage(
  conn: mysql.Connection,
  input: {
    startDay: string;
    endDay: string;
    excludeUsernames?: string[];
    privateUsernames?: string[];
  },
): Promise<DownstreamDailyUsageResult> {
  const days = enumerateDays(input.startDay, input.endDay);
  if (!days.length) {
    return {
      success: false,
      totals: [],
      groups: [],
      totalSource: "none",
      complete: false,
      failedDays: [],
      excludeResolved: false,
      privateResolved: false,
      error: "日期区间为空",
    };
  }

  const excludeSet = new Set(
    (input.excludeUsernames || []).map((n) => n.trim()).filter(Boolean),
  );
  const privateSet = new Set(
    (input.privateUsernames || []).map((n) => n.trim()).filter(Boolean),
  );

  const [dayQuota, userDays, groups] = await Promise.all([
    aggregateLogsDayTotals(conn, input.startDay, input.endDay),
    aggregateLogsByUserDay(conn, input.startDay, input.endDay),
    aggregateLogsByGroupDay(conn, input.startDay, input.endDay),
  ]);

  const perUserByDay = new Map<
    string,
    { quota: number; excluded: number; private: number; requests: number }
  >();
  for (const row of userDays) {
    const bucket =
      perUserByDay.get(row.day) || {
        quota: 0,
        excluded: 0,
        private: 0,
        requests: 0,
      };
    bucket.quota += row.quota;
    bucket.requests += row.requests;
    if (excludeSet.has(row.username)) bucket.excluded += row.quota;
    else if (privateSet.has(row.username)) bucket.private += row.quota;
    perUserByDay.set(row.day, bucket);
  }

  const perUserAvailable = userDays.length > 0;
  const { totals, failedDays } = buildDailyTotals({
    days,
    dayQuota,
    perUserByDay,
    excludeSet,
    privateSet,
    perUserAvailable,
  });

  if (!totals.length) {
    return {
      success: false,
      totals: [],
      groups: [],
      totalSource: "none",
      complete: false,
      failedDays,
      excludeResolved: false,
      privateResolved: false,
      error: "无法从 logs 读取消费统计",
    };
  }

  return {
    success: true,
    totals,
    groups,
    totalSource: "db-logs",
    complete: failedDays.length === 0,
    failedDays,
    excludeResolved: perUserAvailable || excludeSet.size === 0,
    privateResolved: perUserAvailable || privateSet.size === 0,
  };
}

export async function dbFetchDailyUserUsage(
  conn: mysql.Connection,
  input: { startDay: string; endDay: string },
): Promise<DownstreamDailyUserUsageResult> {
  const userDays = await aggregateLogsByUserDay(
    conn,
    input.startDay,
    input.endDay,
  );
  if (!userDays.length) {
    return {
      success: false,
      rows: [],
      complete: false,
      error: "逐用户消费为空，无法执行赠送额度分摊",
    };
  }
  const rows = userDays.map((r) => {
    const { start } = shanghaiDayBounds(r.day);
    return {
      day: r.day,
      occurredAt: new Date(start * 1000),
      username: r.username,
      quota: r.quota,
      requests: r.requests,
    };
  });
  return { success: true, rows, complete: true };
}

export async function dbFetchModelDaily(
  conn: mysql.Connection,
  input: {
    startDay: string;
    endDay: string;
    excludeUsernames?: string[];
    privateUsernames?: string[];
  },
): Promise<DownstreamModelDailyResult> {
  const days = enumerateDays(input.startDay, input.endDay);
  if (!days.length) {
    return {
      success: false,
      rows: [],
      scanned: 0,
      complete: false,
      resolved: false,
      failedDays: [],
      error: "日期区间为空",
    };
  }

  const excludeSet = new Set(
    (input.excludeUsernames || []).map((n) => n.trim()).filter(Boolean),
  );
  const privateSet = new Set(
    (input.privateUsernames || []).map((n) => n.trim()).filter(Boolean),
  );

  const rangeStart = shanghaiDayBounds(input.startDay).start;
  const rangeEnd = shanghaiDayBounds(input.endDay).end;
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT model_name,
            username,
            ${SQL_SH_DAY} AS day,
            COALESCE(SUM(quota), 0) AS quota,
            COUNT(*) AS requests
     FROM logs
     WHERE type = ?
       AND created_at >= ?
       AND created_at <= ?
       AND model_name IS NOT NULL
       AND model_name != ''
     GROUP BY model_name, username, day`,
    [LOG_TYPE_CONSUME, rangeStart, rangeEnd],
  );

  const buckets = new Map<
    string,
    {
      privateQuota: number;
      publicQuota: number;
      privateReq: number;
      publicReq: number;
    }
  >();
  let scanned = 0;
  let resolved = false;

  for (const r of rows || []) {
    const day = String(r.day || "");
    if (!day || day < input.startDay || day > input.endDay) continue;
    const username = String(r.username || "");
    if (!username || excludeSet.has(username)) continue;
    const model = String(r.model_name || "");
    if (!model) continue;
    const quota = Number(r.quota) || 0;
    if (quota <= 0) continue;
    const requests = Number(r.requests) || 0;
    resolved = true;
    scanned += requests;

    const bk = `${day}|${model}`;
    const cur = buckets.get(bk) || {
      privateQuota: 0,
      publicQuota: 0,
      privateReq: 0,
      publicReq: 0,
    };
    if (privateSet.has(username)) {
      cur.privateQuota += quota;
      cur.privateReq += requests;
    } else {
      cur.publicQuota += quota;
      cur.publicReq += requests;
    }
    buckets.set(bk, cur);
  }

  // Days with zero consume logs are fine (empty), not failed.
  const failedDays: string[] = [];

  return {
    success: true,
    rows: [...buckets.entries()].map(([key, v]) => {
      const [day, model] = key.split("|");
      return {
        day,
        model,
        privateQuota: v.privateQuota,
        publicQuota: v.publicQuota,
        privateRequests: v.privateReq,
        publicRequests: v.publicReq,
      };
    }),
    scanned,
    complete: failedDays.length === 0,
    resolved,
    failedDays,
  };
}

export async function dbFetchTopups(
  conn: mysql.Connection,
): Promise<DownstreamTopupResult> {
  const cols = await columnSet(conn, "top_ups");
  if (!cols.has("id") || !cols.has("user_id")) {
    return {
      success: false,
      rows: [],
      scanned: 0,
      total: 0,
      complete: false,
      error: "top_ups 表缺少必要列",
    };
  }

  const select = [
    "id",
    "user_id",
    cols.has("amount") ? "amount" : "0 AS amount",
    cols.has("money") ? "money" : "0 AS money",
    cols.has("trade_no") ? "trade_no" : "'' AS trade_no",
    cols.has("payment_method") ? "payment_method" : "'' AS payment_method",
    cols.has("payment_provider")
      ? "payment_provider"
      : "'' AS payment_provider",
    cols.has("create_time") ? "create_time" : "0 AS create_time",
    cols.has("complete_time") ? "complete_time" : "0 AS complete_time",
    cols.has("status") ? "status" : "'' AS status",
    cols.has("source") ? "source" : "NULL AS source",
  ];

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${select.join(", ")} FROM top_ups ORDER BY id ASC`,
  );

  const out: DownstreamTopupResult["rows"] = [];
  for (const r of rows || []) {
    const remoteId = Number(r.id);
    const userId = Number(r.user_id);
    if (!Number.isFinite(remoteId) || !Number.isFinite(userId)) continue;
    const source = normalizeTopupSource({
      source: r.source,
      payment_method: r.payment_method,
      payment_provider: r.payment_provider,
    });
    out.push({
      remoteId,
      userId,
      amount: Number(r.amount) || 0,
      moneyRmb: Number(r.money) || 0,
      tradeNo: typeof r.trade_no === "string" ? r.trade_no : String(r.trade_no || ""),
      paymentMethod:
        typeof r.payment_method === "string"
          ? r.payment_method
          : String(r.payment_method || ""),
      paymentProvider:
        typeof r.payment_provider === "string"
          ? r.payment_provider
          : String(r.payment_provider || ""),
      ...source,
      status:
        typeof r.status === "string" ? r.status : String(r.status ?? ""),
      createdAt: unixSecondsToDate(Number(r.create_time)),
      completedAt: unixSecondsToDate(Number(r.complete_time)),
    });
  }

  return {
    success: true,
    rows: out,
    scanned: out.length,
    total: out.length,
    complete: true,
  };
}

export async function dbFetchRedemptions(
  conn: mysql.Connection,
): Promise<DownstreamRedemptionResult> {
  const cols = await columnSet(conn, "redemptions");
  if (!cols.has("id")) {
    return {
      success: false,
      rows: [],
      scanned: 0,
      total: 0,
      complete: false,
      error: "redemptions 表缺少必要列",
    };
  }

  const select = [
    "id",
    cols.has("name") ? "name" : "'' AS name",
    cols.has("key") ? "`key` AS redeem_key" : "'' AS redeem_key",
    cols.has("quota") ? "quota" : "0 AS quota",
    cols.has("status") ? "status" : "0 AS status",
    cols.has("created_time") ? "created_time" : "0 AS created_time",
    cols.has("redeemed_time") ? "redeemed_time" : "0 AS redeemed_time",
    cols.has("used_user_id") ? "used_user_id" : "NULL AS used_user_id",
    cols.has("expired_time") ? "expired_time" : "0 AS expired_time",
  ];
  const where = cols.has("deleted_at") ? "WHERE deleted_at IS NULL" : "";

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT ${select.join(", ")} FROM redemptions ${where} ORDER BY id ASC`,
  );

  const out: DownstreamRedemptionResult["rows"] = [];
  for (const r of rows || []) {
    const remoteId = Number(r.id);
    if (!Number.isFinite(remoteId)) continue;
    const used = r.used_user_id == null ? null : Number(r.used_user_id);
    out.push({
      remoteId,
      name: typeof r.name === "string" ? r.name : String(r.name || ""),
      key:
        typeof r.redeem_key === "string"
          ? r.redeem_key
          : String(r.redeem_key || ""),
      quota: Number(r.quota) || 0,
      status: Number(r.status) || 0,
      createdAt: unixSecondsToDate(Number(r.created_time)),
      redeemedAt: unixSecondsToDate(Number(r.redeemed_time)),
      usedUserId: used != null && Number.isFinite(used) ? used : null,
      expiredAt: unixSecondsToDate(Number(r.expired_time)),
    });
  }

  return {
    success: true,
    rows: out,
    scanned: out.length,
    total: out.length,
    complete: true,
  };
}
