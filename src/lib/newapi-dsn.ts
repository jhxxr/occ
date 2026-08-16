/**
 * NewAPI SQL_DSN (Go mysql driver) helpers.
 *
 * Format (same as NewAPI .env):
 *   user:password@tcp(host:3306)/dbname?parseTime=true
 *
 * Also accepts mysql:// URLs for paste convenience.
 * Connections are short-lived (test only in phase 1) — no global pool.
 * Prefer a MySQL read-only account in production.
 *
 * Query params: only a small TLS-related subset is applied to mysql2.
 * parseTime/loc/charset etc. are ignored for the phase-1 SELECT 1 probe.
 */

import mysql from "mysql2/promise";

export interface ParsedNewApiDsn {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  /** Original query string without leading ? */
  params: string;
}

export interface NewApiDsnTestResult {
  ok: boolean;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  error?: string;
  latencyMs?: number;
}

/**
 * Groups:
 * 1=user 2=password
 * 3=bracket-host (IPv6) 4=bracket-port?
 * 5=plain-host 6=plain-port?
 * 7=database 8=params?
 */
const GO_DSN_RE =
  /^([^:@/?]+):(.*)@tcp\((?:\[([^\]]+)\](?::(\d+))?|([^:)\]]+)(?::(\d+))?)\)\/([^?]+)(?:\?(.*))?$/;

function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** decodeURIComponent; leave original on malformed sequences (raw Go DSN passwords). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseQueryParams(params: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params) return out;
  for (const part of params.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = safeDecode((eq >= 0 ? part.slice(0, eq) : part).trim()).toLowerCase();
    const val = eq >= 0 ? safeDecode(part.slice(eq + 1).trim()) : "";
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Map a subset of Go / mysql connector TLS flags onto mysql2 `ssl`.
 * Returns undefined when TLS is not requested.
 */
export function sslOptionFromParams(
  params: string,
): mysql.ConnectionOptions["ssl"] | undefined {
  const q = parseQueryParams(params);
  const tls = (q.tls || q.ssl || q["ssl-mode"] || q.sslmode || "").toLowerCase();
  if (!tls) return undefined;
  if (tls === "false" || tls === "0" || tls === "disable" || tls === "disabled") {
    return undefined;
  }
  // true / required / skip-verify / preferred / verify_* → TLS on.
  // Empty object = encrypt with Node default trust store (no custom CA files in phase 1).
  if (
    tls === "true" ||
    tls === "1" ||
    tls === "required" ||
    tls === "require" ||
    tls === "preferred" ||
    tls === "skip-verify" ||
    tls === "verify_ca" ||
    tls === "verify-ca" ||
    tls === "verify_identity" ||
    tls === "verify-identity"
  ) {
    return {};
  }
  // Unknown non-empty tls value: enable TLS conservatively
  return {};
}

/**
 * Parse Go-style mysql DSN or mysql:// URL into connection parts.
 * Throws Error with Chinese message on invalid input.
 */
export function parseGoMysqlDsn(raw: string): ParsedNewApiDsn {
  const input = stripWrappingQuotes(raw || "");
  if (!input) {
    throw new Error("请填写数据库 DSN");
  }

  if (/^mysql:\/\//i.test(input)) {
    return parseMysqlUrl(input);
  }

  const m = input.match(GO_DSN_RE);
  if (!m) {
    throw new Error(
      "DSN 格式无效。请使用 NewAPI 同款：user:pass@tcp(host:3306)/dbname",
    );
  }

  const user = safeDecode(m[1] || "").trim();
  // Password may contain ':', '@', etc. The greedy capture between first ':' after user
  // and '@tcp(' is intentional for Go DSN. Percent-encoding is decoded when valid.
  const password = safeDecode(m[2] ?? "");
  const host = (m[3] || m[5] || "").trim();
  const portRaw = m[4] || m[6];
  const port = portRaw ? Number(portRaw) : 3306;
  const database = safeDecode((m[7] || "").trim());
  const params = (m[8] || "").trim();

  if (!user) throw new Error("DSN 缺少用户名");
  if (!host) throw new Error("DSN 缺少主机地址");
  if (!database) throw new Error("DSN 缺少数据库名");
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("DSN 端口无效");
  }

  return { user, password, host, port, database, params };
}

function parseMysqlUrl(input: string): ParsedNewApiDsn {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("mysql:// URL 无法解析");
  }
  if (url.protocol !== "mysql:") {
    throw new Error("仅支持 mysql:// 协议");
  }
  const user = safeDecode(url.username || "").trim();
  const password = safeDecode(url.password || "");
  const host = (url.hostname || "").trim();
  const port = url.port ? Number(url.port) : 3306;
  const database = safeDecode(url.pathname.replace(/^\//, "")).trim();
  const params = url.search.startsWith("?") ? url.search.slice(1) : url.search;

  if (!user) throw new Error("DSN 缺少用户名");
  if (!host) throw new Error("DSN 缺少主机地址");
  if (!database) throw new Error("DSN 缺少数据库名");
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("DSN 端口无效");
  }

  return { user, password, host, port, database, params };
}

/** user:••••@tcp(host:port)/db — never include password */
export function maskGoDsn(raw: string): string {
  try {
    const p = parseGoMysqlDsn(raw);
    const hostPart = p.host.includes(":") ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`;
    return `${p.user}:••••@tcp(${hostPart})/${p.database}`;
  } catch {
    return "••••（已绑定）";
  }
}

export function humanizeMysqlError(err: unknown): string {
  const e = err as {
    code?: string;
    errno?: number;
    sqlMessage?: string;
    message?: string;
  };
  const code = e?.code || "";
  const msg = String(e?.sqlMessage || e?.message || err || "未知错误");

  // Never echo connection strings that might appear in driver messages
  const scrubbed = msg
    .replace(/mysql:\/\/[^\s]+/gi, "mysql://***")
    .replace(/[^:\s]+:[^@\s]+@tcp\([^)]+\)\/\S+/g, "***");

  if (code === "ETIMEDOUT" || code === "PROTOCOL_CONNECTION_LOST") {
    return "连接超时，请检查主机、端口与网络";
  }
  if (code === "ECONNREFUSED") {
    return "连接被拒绝，请确认 MySQL 已启动且端口正确";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "无法解析主机名";
  }
  if (code === "ER_ACCESS_DENIED_ERROR" || e?.errno === 1045) {
    return "账号或密码错误";
  }
  if (code === "ER_BAD_DB_ERROR" || e?.errno === 1049) {
    return "数据库不存在";
  }
  if (code === "ER_DBACCESS_DENIED_ERROR" || e?.errno === 1044) {
    return "无权访问该数据库";
  }
  // Keep message short
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed;
}

/**
 * Open a one-shot connection, run SELECT 1, close.
 * Does not log the DSN or password.
 */
export async function testNewApiDsn(
  raw: string,
  opts: { timeoutMs?: number } = {},
): Promise<NewApiDsnTestResult> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  let parsed: ParsedNewApiDsn;
  try {
    parsed = parseGoMysqlDsn(raw);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "DSN 无效",
    };
  }

  const started = Date.now();
  let conn: mysql.Connection | null = null;
  try {
    const ssl = sslOptionFromParams(parsed.params);
    conn = await mysql.createConnection({
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      connectTimeout: timeoutMs,
      // read-only intent: we only SELECT 1
      multipleStatements: false,
      ...(ssl !== undefined ? { ssl } : {}),
    });
    await conn.query("SELECT 1 AS ok");
    return {
      ok: true,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      error: humanizeMysqlError(e),
      latencyMs: Date.now() - started,
    };
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
