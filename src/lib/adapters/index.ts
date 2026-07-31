import { normalizeBaseUrl } from "@/lib/utils";
import { addDays, enumerateDays, shanghaiDay } from "@/lib/reporting-period";
import type {
  DownstreamAdapterInput,
  DownstreamChannelUsageResult,
  DownstreamChannelUsageRow,
  DownstreamDailyRow,
  DownstreamDailyUsageResult,
  DownstreamFetchResult,
  DownstreamGroupDailyRow,
  DownstreamUserRow,
  UpstreamAdapterInput,
  UpstreamFetchResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_QUOTA_PER_DOLLAR = 500_000;
/** Refresh access token this many ms before expiry */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 每个主机的请求节流器。
 *
 * 翻日志动辄两百多页，连着打会把对方站点打到限流（甚至连累到正常登录）。
 * 所以同一主机的请求串行 + 保底间隔；遇到 429 就整体退避一段时间，
 * 让这期间排队的请求一起等，而不是各自重试继续加压。
 */
const hostGate = new Map<string, { chain: Promise<void>; blockedUntil: number }>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 同主机最小请求间隔，压住突发流量 */
const MIN_REQUEST_GAP_MS = 120;
/** 命中 429 后整个主机静默多久（会随连续 429 递增） */
const RATE_LIMIT_COOLDOWN_MS = 3_000;
const MAX_RETRIES = 3;

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES, ...rest } = init;
  const host = hostOf(url);
  const gate = hostGate.get(host) || { chain: Promise.resolve(), blockedUntil: 0 };

  // 串到该主机的队尾：同一主机永不并发
  const run = gate.chain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const state = hostGate.get(host);
      if (state && state.blockedUntil > now) {
        await sleep(state.blockedUntil - now);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { ...rest, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      // 429 / 503：退避后重试，并让同主机的后续请求一起等
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : RATE_LIMIT_COOLDOWN_MS * Math.pow(2, attempt);
        const cur = hostGate.get(host);
        if (cur) cur.blockedUntil = Date.now() + waitMs;
        await sleep(waitMs);
        continue;
      }

      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      await sleep(MIN_REQUEST_GAP_MS);
      return { ok: res.ok, status: res.status, data, text };
    }
  });

  // 无论成败都要把链条接上，否则一次异常会永久卡住该主机
  hostGate.set(host, {
    chain: run.then(
      () => undefined,
      () => undefined,
    ),
    blockedUntil: gate.blockedUntil,
  });
  return run;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function quotaToUsd(quota: number, quotaPerDollar: number): number {
  if (!quotaPerDollar) return 0;
  return quota / quotaPerDollar;
}

/**
 * Build common NewAPI-style auth headers.
 * NewAPI accepts Authorization as the access token (sometimes with Bearer).
 */
function newApiHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: token.startsWith("Bearer ") ? token : token,
    "New-API-User": "0",
  };
}

/** Try NewAPI / OneAPI user self endpoint */
async function fetchNewApiUser(
  baseUrl: string,
  apiKey: string,
  quotaPerDollar: number,
): Promise<UpstreamFetchResult> {
  const base = normalizeBaseUrl(baseUrl);
  const paths = ["/api/user/self", "/api/user/", "/v1/dashboard"];

  let lastError = "No endpoint responded";
  for (const path of paths) {
    try {
      const { ok, status, data } = await fetchJson(`${base}${path}`, {
        method: "GET",
        headers: newApiHeaders(apiKey),
      });

      if (!ok) {
        lastError = `HTTP ${status} on ${path}`;
        if (status === 401 || status === 403) {
          const retry = await fetchJson(`${base}${path}`, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
          });
          if (retry.ok) {
            return parseNewApiBalance(retry.data, quotaPerDollar);
          }
          lastError = `HTTP ${retry.status} on ${path} (token invalid?)`;
        }
        continue;
      }

      return parseNewApiBalance(data, quotaPerDollar);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (lastError.includes("abort")) lastError = "Request timeout";
    }
  }

  return { success: false, balance: 0, consumed: 0, error: lastError };
}

function parseNewApiBalance(data: unknown, quotaPerDollar: number): UpstreamFetchResult {
  const root = asRecord(data);
  const payload = asRecord(root?.data) ?? root ?? {};

  const balanceUsd = num(
    payload.balance,
    payload.Balance,
    payload.dollar_balance,
    payload.wallet_balance,
  );

  const quota = num(payload.quota, payload.Quota, payload.remain_quota);
  const usedQuota = num(
    payload.used_quota,
    payload.UsedQuota,
    payload.used,
    payload.consume,
  );

  let balance = balanceUsd;
  if (balance == null && quota != null) {
    balance = quotaToUsd(quota, quotaPerDollar);
  }

  let consumed = 0;
  if (usedQuota != null) {
    consumed =
      usedQuota > 10_000
        ? quotaToUsd(usedQuota, quotaPerDollar)
        : usedQuota;
  }

  if (balance == null) {
    return {
      success: false,
      balance: 0,
      consumed: 0,
      error: "Could not parse balance from response",
      raw: data,
    };
  }

  return {
    success: true,
    balance,
    consumed,
    raw: data,
  };
}

function normalizeSub2Token(raw: string): string {
  const t = raw.trim();
  if (t.toLowerCase().startsWith("bearer ")) return t.slice(7).trim();
  return t;
}

function sub2BearerHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${normalizeSub2Token(token)}`,
    Accept: "application/json",
  };
}

/** Unwrap Sub2API `{ code: 0, data }` envelope */
function unwrapSub2(data: unknown): Record<string, unknown> {
  const root = asRecord(data);
  if (!root) return {};
  const code = root.code;
  if (code === 0 || code === "0" || code === "success") {
    return asRecord(root.data) ?? root;
  }
  if ("balance" in root || "email" in root || "username" in root || "access_token" in root) {
    return root;
  }
  return asRecord(root.data) ?? root;
}

function isSub2Success(data: unknown, httpOk: boolean): boolean {
  if (!httpOk) return false;
  const root = asRecord(data);
  if (!root) return false;
  if (root.code === 0 || root.code === "0" || root.code === "success") return true;
  // Some deployments may return bare objects on success
  if ("access_token" in root || "balance" in root) return true;
  return false;
}

interface Sub2TokenPair {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  userRaw?: unknown;
}

function parseSub2AuthPayload(data: unknown): Sub2TokenPair | null {
  const payload = unwrapSub2(data);
  const access =
    (typeof payload.access_token === "string" && payload.access_token) ||
    (typeof payload.token === "string" && payload.token) ||
    null;
  if (!access) return null;
  const refresh =
    (typeof payload.refresh_token === "string" && payload.refresh_token) || null;
  const expiresIn = num(payload.expires_in, payload.ExpiresIn);
  const expiresAt =
    expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : null;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt,
    userRaw: payload.user ?? payload,
  };
}

/** POST /api/v1/auth/login */
export async function sub2Login(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ ok: true; tokens: Sub2TokenPair } | { ok: false; error: string; raw?: unknown }> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const { ok, status, data } = await fetchJson(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!isSub2Success(data, ok)) {
      const root = asRecord(data);
      const msg =
        (typeof root?.message === "string" && root.message) ||
        `Login failed (HTTP ${status})`;
      return { ok: false, error: msg, raw: data };
    }
    const tokens = parseSub2AuthPayload(data);
    if (!tokens) {
      return { ok: false, error: "Login response missing access_token", raw: data };
    }
    return { ok: true, tokens };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes("abort") ? "Login timeout" : msg };
  }
}

/** POST /api/v1/auth/refresh  body: { refresh_token } */
export async function sub2Refresh(
  baseUrl: string,
  refreshToken: string,
): Promise<{ ok: true; tokens: Sub2TokenPair } | { ok: false; error: string; raw?: unknown }> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const { ok, status, data } = await fetchJson(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!isSub2Success(data, ok)) {
      const root = asRecord(data);
      const msg =
        (typeof root?.message === "string" && root.message) ||
        `Refresh failed (HTTP ${status})`;
      return { ok: false, error: msg, raw: data };
    }
    const tokens = parseSub2AuthPayload(data);
    if (!tokens) {
      return { ok: false, error: "Refresh response missing access_token", raw: data };
    }
    // Keep old refresh if new one not returned
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    return { ok: true, tokens };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes("abort") ? "Refresh timeout" : msg };
  }
}

function tokenLooksExpired(expiresAt?: Date | string | null): boolean {
  if (!expiresAt) return false;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return false;
  return t - Date.now() <= TOKEN_REFRESH_SKEW_MS;
}

async function fetchSub2ProfileAndStats(
  base: string,
  accessToken: string,
): Promise<UpstreamFetchResult & { unauthorized?: boolean }> {
  const headers = sub2BearerHeaders(accessToken);
  const profilePaths = ["/api/v1/user/profile", "/api/v1/auth/me"];

  let lastError = "Sub2API 未返回可用资料";
  let profileRaw: unknown = null;
  let balance: number | null = null;
  let consumed = 0;

  for (const path of profilePaths) {
    try {
      const { ok, status, data } = await fetchJson(`${base}${path}`, {
        method: "GET",
        headers,
      });
      profileRaw = data;

      if (!ok) {
        const root = asRecord(data);
        const msg =
          (typeof root?.message === "string" && root.message) ||
          (typeof root?.code === "string" && root.code) ||
          `HTTP ${status}`;
        if (status === 401 || status === 403) {
          return {
            success: false,
            balance: 0,
            consumed: 0,
            error: `JWT 无效或已过期（${msg}）`,
            raw: data,
            unauthorized: true,
          };
        }
        lastError = `${path}: ${msg}`;
        continue;
      }

      const user = unwrapSub2(data);
      const nested = asRecord(user.user);
      const src = nested && "balance" in nested ? nested : user;
      const bal = num(
        src.balance,
        src.Balance,
        src.available_balance,
        src.wallet_balance,
      );
      if (bal != null) {
        balance = bal;
        break;
      }
      lastError = `${path}: 响应中无 balance 字段`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (lastError.includes("abort")) lastError = "Request timeout";
    }
  }

  try {
    const { ok, data } = await fetchJson(`${base}/api/v1/usage/dashboard/stats`, {
      method: "GET",
      headers,
    });
    if (ok) {
      const stats = unwrapSub2(data);
      const spent = num(
        stats.total_actual_cost,
        stats.total_cost,
        stats.TotalActualCost,
      );
      if (spent != null) consumed = spent;
    }
  } catch {
    // non-fatal
  }

  if (balance == null) {
    return { success: false, balance: 0, consumed: 0, error: lastError, raw: profileRaw };
  }
  return { success: true, balance, consumed, raw: profileRaw };
}

/**
 * Sub2API balance fetch with automatic token lifecycle:
 * 1. If access token missing/near-expiry → refresh or password login
 * 2. Fetch profile; on 401 → refresh then login fallback
 * 3. Return authUpdate so caller can persist new tokens
 */
async function fetchSub2Api(input: UpstreamAdapterInput): Promise<UpstreamFetchResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  let accessToken = normalizeSub2Token(input.apiKey || "");
  let refreshToken = input.refreshToken?.trim() || null;
  const email = input.accountEmail?.trim() || null;
  const password = input.accountPassword || null;

  let authUpdate: UpstreamFetchResult["authUpdate"] | undefined;

  const ensureTokens = async (force = false): Promise<string | null> => {
    const needFresh =
      force ||
      !accessToken ||
      accessToken.startsWith("sk-") ||
      tokenLooksExpired(input.tokenExpiresAt ?? null);

    if (!needFresh && accessToken) return accessToken;

    // 1) refresh
    if (refreshToken) {
      const refreshed = await sub2Refresh(base, refreshToken);
      if (refreshed.ok) {
        accessToken = refreshed.tokens.accessToken;
        refreshToken = refreshed.tokens.refreshToken;
        authUpdate = {
          accessToken,
          refreshToken,
          expiresAt: refreshed.tokens.expiresAt,
        };
        return accessToken;
      }
    }

    // 2) password login
    if (email && password) {
      const logged = await sub2Login(base, email, password);
      if (logged.ok) {
        accessToken = logged.tokens.accessToken;
        refreshToken = logged.tokens.refreshToken;
        authUpdate = {
          accessToken,
          refreshToken,
          expiresAt: logged.tokens.expiresAt,
        };
        return accessToken;
      }
      return null;
    }

    return accessToken || null;
  };

  // Bootstrap tokens if we only have email/password
  if (!accessToken || accessToken.startsWith("sk-") || tokenLooksExpired(input.tokenExpiresAt ?? null)) {
    const t = await ensureTokens(true);
    if (!t) {
      if (!email || !password) {
        return {
          success: false,
          balance: 0,
          consumed: 0,
          error:
            "Sub2API 需要面板邮箱+密码（自动登录），或有效的 JWT access_token。sk- 网关 Key 无效。",
        };
      }
      return {
        success: false,
        balance: 0,
        consumed: 0,
        error: "Sub2API 自动登录失败，请检查邮箱/密码",
      };
    }
  }

  let result = await fetchSub2ProfileAndStats(base, accessToken);

  // On unauthorized, force re-auth once
  if (!result.success && result.unauthorized) {
    const t = await ensureTokens(true);
    if (t) {
      result = await fetchSub2ProfileAndStats(base, t);
    } else if (email && password) {
      result = {
        success: false,
        balance: 0,
        consumed: 0,
        error: "JWT 过期且自动登录失败，请检查邮箱/密码",
      };
    }
  }

  if (result.success && authUpdate) {
    result.authUpdate = authUpdate;
  } else if (!result.success && authUpdate) {
    // Still return authUpdate if we got tokens but profile failed for other reasons
    result.authUpdate = authUpdate;
  }

  // Clean internal flag
  delete (result as { unauthorized?: boolean }).unauthorized;
  return result;
}

/**
 * Unified upstream balance fetcher.
 * Dispatches by provider type and normalizes to USD.
 */
export async function fetchUpstreamBalance(
  input: UpstreamAdapterInput,
): Promise<UpstreamFetchResult> {
  const quotaPerDollar = input.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const type = (input.type || "NEWAPI").toUpperCase();

  try {
    switch (type) {
      case "SUB2API":
        return await fetchSub2Api(input);
      case "ONEAPI":
      case "NEWAPI":
      case "OTHER":
      default:
        return await fetchNewApiUser(input.baseUrl, input.apiKey, quotaPerDollar);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      balance: 0,
      consumed: 0,
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

/**
 * Build NewAPI admin headers.
 * NewAPI access tokens require:
 *   Authorization: <token>   (NOT Bearer)
 *   New-API-User: <userId>   (must match token owner, root usually 1)
 */
function newApiAdminHeaders(token: string, userId: number): HeadersInit {
  const raw = token.startsWith("Bearer ") ? token.slice(7).trim() : token.trim();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: raw,
    "New-API-User": String(userId),
  };
}

/**
 * NewAPI 出错时经常回 HTTP 200 + {"success":false,"message":"..."}。
 * 只看 res.ok 会把它当成「这天没有日志」，进而落成永久锚点、成本永远是 0。
 * 所以拿不到 success:true 就必须当失败处理。
 */
function newApiFailure(data: unknown): string | null {
  const root = asRecord(data);
  if (!root) return null;
  if (root.success === false || root.code === false) {
    return (
      (typeof root.message === "string" && root.message) ||
      (typeof root.error === "string" && root.error) ||
      "上游返回失败"
    );
  }
  return null;
}

/**
 * Downstream NewAPI admin stats (self-operated relay).
 *
 * Auth (confirmed on compatible NewAPI deployments):
 * - Authorization: access token (no Bearer)
 * - New-API-User: owner user id
 *
 * Metrics:
 * - consumed: /api/log/stat quota  or sum users.used_quota  → USD
 * - revenue:  sum over non-admin users of (quota + used_quota) ≈ issued credit → USD
 *   (true CNY top-up ledger may not be exposed; use USD credit issued as revenue proxy)
 */
export async function fetchDownstreamStats(
  input: DownstreamAdapterInput,
): Promise<DownstreamFetchResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const quotaPerDollar = input.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);

  try {
    // 1) Auth probe + identity
    const selfRes = await fetchJson(`${base}/api/user/self`, {
      method: "GET",
      headers,
    });
    if (!selfRes.ok) {
      // Retry a few common root ids if misconfigured
      let last = selfRes;
      if (userId === 1) {
        for (const tryId of [1]) {
          last = await fetchJson(`${base}/api/user/self`, {
            method: "GET",
            headers: newApiAdminHeaders(input.adminKey, tryId),
          });
          if (last.ok) break;
        }
      }
      if (!last.ok) {
        const root = asRecord(last.data);
        return {
          success: false,
          consumed: 0,
          revenue: 0,
          revenueCurrency: "USD",
          error:
            (typeof root?.message === "string" && root.message) ||
            `Admin auth failed (HTTP ${last.status}). Check access token and New-API-User id.`,
          raw: last.data,
        };
      }
    }

    // 2) Period consumption via log/stat (last 30 days)
    const now = Math.floor(Date.now() / 1000);
    const start = now - 30 * 24 * 3600;
    let consumed = 0;
    let revenue = 0;
    let raw: unknown = selfRes.data;

    const statRes = await fetchJson(
      `${base}/api/log/stat?start_timestamp=${start}&end_timestamp=${now}`,
      { method: "GET", headers },
    );
    if (statRes.ok) {
      const stat = asRecord(asRecord(statRes.data)?.data) ?? asRecord(statRes.data) ?? {};
      const q = num(stat.quota, stat.used_quota);
      if (q != null) {
        consumed = q > 1000 ? quotaToUsd(q, quotaPerDollar) : q;
      }
      raw = { self: selfRes.data, stat: statRes.data };
    }

    // 3) Users list → issued credit as revenue proxy (with exclusions)
    const excludeSet = new Set(
      (input.excludeUserIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
    );
    const usersRes = await fetchJson(`${base}/api/user/?p=0&page_size=1000`, {
      method: "GET",
      headers,
    });
    if (usersRes.ok) {
      const udata = asRecord(usersRes.data);
      const payload = asRecord(udata?.data) ?? udata;
      const items = (payload?.items ?? payload?.data ?? []) as unknown;
      if (Array.isArray(items)) {
        let issuedQuota = 0;
        let usedQuota = 0;
        let excludedIssued = 0;
        let countedUsers = 0;
        let excludedUsers = 0;
        for (const row of items) {
          const u = asRecord(row);
          if (!u) continue;
          const id = num(u.id);
          const r = num(u.role) ?? 0;
          const q = num(u.quota) ?? 0;
          const used = num(u.used_quota) ?? 0;
          // Always skip super-admin pool (role 100)
          if (r >= 100) {
            excludedUsers++;
            excludedIssued += q + used;
            continue;
          }
          if (id != null && excludeSet.has(id)) {
            excludedUsers++;
            excludedIssued += q + used;
            continue;
          }
          issuedQuota += q + used;
          usedQuota += used;
          countedUsers++;
        }
        revenue = quotaToUsd(issuedQuota, quotaPerDollar);
        if (consumed === 0 && usedQuota > 0) {
          consumed = quotaToUsd(usedQuota, quotaPerDollar);
        }
        raw = {
          self: selfRes.data,
          stat: statRes.data,
          users_summary: {
            issuedQuota,
            usedQuota,
            countedUsers,
            excludedUsers,
            excludedIssuedQuota: excludedIssued,
            excludeUserIds: [...excludeSet],
          },
        };
      }
    }

    // 4) Optional: /api/data/ period rows sum
    if (consumed === 0) {
      const dataRes = await fetchJson(
        `${base}/api/data/?start_timestamp=${start}&end_timestamp=${now}`,
        { method: "GET", headers },
      );
      if (dataRes.ok) {
        const rows = asRecord(dataRes.data)?.data;
        if (Array.isArray(rows)) {
          const sumQ = rows.reduce((s: number, row: unknown) => {
            const r = asRecord(row);
            return s + (num(r?.quota) ?? 0);
          }, 0);
          if (sumQ > 0) consumed = quotaToUsd(sumQ, quotaPerDollar);
        }
      }
    }

    return {
      success: true,
      consumed,
      revenue,
      revenueCurrency: input.revenueCurrency === "USD" ? "USD" : "CNY",
      raw,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      consumed: 0,
      revenue: 0,
      revenueCurrency: "USD",
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

/** List NewAPI users for revenue exclusion UI */
export async function listDownstreamUsers(
  input: DownstreamAdapterInput,
): Promise<
  | { success: true; users: DownstreamUserRow[] }
  | { success: false; error: string }
> {
  const base = normalizeBaseUrl(input.baseUrl);
  const quotaPerDollar = input.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const excludeSet = new Set(
    (input.excludeUserIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
  );

  try {
    const usersRes = await fetchJson(`${base}/api/user/?p=0&page_size=1000`, {
      method: "GET",
      headers,
    });
    if (!usersRes.ok) {
      const root = asRecord(usersRes.data);
      return {
        success: false,
        error:
          (typeof root?.message === "string" && root.message) ||
          `拉取用户失败 (HTTP ${usersRes.status})`,
      };
    }
    const udata = asRecord(usersRes.data);
    const payload = asRecord(udata?.data) ?? udata;
    const items = (payload?.items ?? payload?.data ?? []) as unknown;
    if (!Array.isArray(items)) {
      return { success: false, error: "用户列表格式无法解析" };
    }

    const users: DownstreamUserRow[] = [];
    for (const row of items) {
      const u = asRecord(row);
      if (!u) continue;
      const id = num(u.id);
      if (id == null) continue;
      const quota = num(u.quota) ?? 0;
      const used = num(u.used_quota) ?? 0;
      const role = num(u.role) ?? 0;
      const autoExcluded = role >= 100;
      users.push({
        id,
        username: String(u.username || ""),
        display_name: typeof u.display_name === "string" ? u.display_name : undefined,
        role,
        status: num(u.status) ?? undefined,
        email: typeof u.email === "string" ? u.email : undefined,
        quota,
        used_quota: used,
        issuedUsd: quotaToUsd(quota + used, quotaPerDollar),
        usedUsd: quotaToUsd(used, quotaPerDollar),
        request_count: num(u.request_count) ?? undefined,
        excluded: autoExcluded || excludeSet.has(id),
      });
    }
    users.sort((a, b) => b.issuedUsd - a.issuedUsd);

    return { success: true, users };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

/** 某个 Asia/Shanghai 日历日的 unix 秒区间（含首含尾，跟 NewAPI 的比较方式一致） */
function shanghaiDayBounds(day: string): { start: number; end: number } {
  const start = Math.floor(new Date(`${day}T00:00:00+08:00`).getTime() / 1000);
  const end = Math.floor(new Date(`${addDays(day, 1)}T00:00:00+08:00`).getTime() / 1000) - 1;
  return { start, end };
}

/**
 * 下游按日实际消费。
 *
 * 存两个口径，别混用：
 * - 全部账号消费（含测试号）：跟上游成本对差值，因为测试号也烧了上游额度
 * - 付费账号消费：这才是收入。测试号没人付钱。
 *
 * 逐账号拆分只能靠 `/api/data/users`（按 username × 小时聚合）。
 * 拿不到时退回全站口径，并把 excludeResolved 标成 false —— 让上层知道
 * 这个数里还混着测试号，而不是假装已经扣干净了。
 */
export async function fetchDownstreamDailyUsage(
  input: DownstreamAdapterInput & {
    startDay: string;
    endDay: string;
    /** 被排除账号的用户名（测试号）；逐账号拆分要用名字而不是 id */
    excludeUsernames?: string[];
  },
): Promise<DownstreamDailyUsageResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const days = enumerateDays(input.startDay, input.endDay);
  const failedDays: string[] = [];

  if (!days.length) {
    return {
      success: false,
      totals: [],
      groups: [],
      totalSource: "none",
      complete: false,
      failedDays: [],
      excludeResolved: false,
      error: "日期区间为空",
    };
  }

  const excludeSet = new Set(
    (input.excludeUsernames || []).map((n) => n.trim()).filter(Boolean),
  );

  try {
    const rangeStart = shanghaiDayBounds(input.startDay).start;
    const rangeEnd = shanghaiDayBounds(input.endDay).end;

    // 1) 逐账号日消费：唯一能把测试号拆出来的来源
    const perUser = new Map<string, { quota: number; excluded: number; requests: number }>();
    let excludeResolved = false;
    const usersRes = await fetchJson(
      `${base}/api/data/users?start_timestamp=${rangeStart}&end_timestamp=${rangeEnd}`,
      { method: "GET", headers, timeoutMs: 30_000 },
    );
    if (usersRes.ok) {
      const rows = asRecord(usersRes.data)?.data;
      if (Array.isArray(rows)) {
        // 空数组 ≠ 拆得出测试号。站点没开数据看板导出时这里就是 []，
        // 此时若报 resolved，测试号消费会被当成收入且不会有任何警告。
        excludeResolved = rows.length > 0;
        for (const row of rows) {
          const r = asRecord(row);
          if (!r) continue;
          const createdAt = num(r.created_at);
          if (createdAt == null) continue;
          const day = shanghaiDay(createdAt * 1000);
          if (day < input.startDay || day > input.endDay) continue;
          const quota = num(r.quota) ?? 0;
          const count = num(r.count) ?? 0;
          const username = typeof r.username === "string" ? r.username : "";
          const bucket =
            perUser.get(day) || { quota: 0, excluded: 0, requests: 0 };
          bucket.quota += quota;
          bucket.requests += count;
          if (excludeSet.has(username)) bucket.excluded += quota;
          perUser.set(day, bucket);
        }
      }
    }

    // 2) 数据看板按模型/分组聚合：补分组归因（拿不到账号维度）
    const dayQuotaFromData = new Map<string, { quota: number; requests: number }>();
    const groupBuckets = new Map<string, DownstreamGroupDailyRow>();
    let dataExportOk = false;
    const dataRes = await fetchJson(
      `${base}/api/data/?start_timestamp=${rangeStart}&end_timestamp=${rangeEnd}`,
      { method: "GET", headers, timeoutMs: 30_000 },
    );
    if (dataRes.ok) {
      const rows = asRecord(dataRes.data)?.data;
      if (Array.isArray(rows)) {
        dataExportOk = true;
        for (const row of rows) {
          const r = asRecord(row);
          if (!r) continue;
          const createdAt = num(r.created_at);
          if (createdAt == null) continue;
          const day = shanghaiDay(createdAt * 1000);
          if (day < input.startDay || day > input.endDay) continue;
          const quota = num(r.quota) ?? 0;
          const count = num(r.count) ?? 0;
          const bucket = dayQuotaFromData.get(day) || { quota: 0, requests: 0 };
          bucket.quota += quota;
          bucket.requests += count;
          dayQuotaFromData.set(day, bucket);

          const groupName = typeof r.use_group === "string" ? r.use_group : "";
          const gk = `${day}|${groupName}`;
          const g = groupBuckets.get(gk) || { day, groupName, quota: 0, requests: 0 };
          g.quota += quota;
          g.requests += count;
          groupBuckets.set(gk, g);
        }
      }
    }

    // 3) 逐日 log/stat：全站消费的权威值
    const totals: DownstreamDailyRow[] = [];
    let statOkCount = 0;
    for (const day of days) {
      const { start, end } = shanghaiDayBounds(day);
      const res = await fetchJson(
        `${base}/api/log/stat?type=2&start_timestamp=${start}&end_timestamp=${end}`,
        { method: "GET", headers },
      );
      const payload = res.ok
        ? asRecord(asRecord(res.data)?.data) ?? asRecord(res.data)
        : null;
      const statQuota = payload ? num(payload.quota) : null;
      const fromUsers = perUser.get(day);
      const fromData = dayQuotaFromData.get(day);

      const quota = statQuota ?? fromUsers?.quota ?? fromData?.quota ?? null;
      if (quota == null) {
        failedDays.push(day);
        continue;
      }
      if (statQuota != null) statOkCount++;

      // 排除额按逐账号数据算。若 log/stat 的全站口径与逐账号总量有偏差，
      // 按比例缩放排除额，避免「排除额 > 全站消费」这种荒唐结果。
      let excludedQuota = 0;
      if (fromUsers && fromUsers.excluded > 0) {
        excludedQuota =
          fromUsers.quota > 0 && quota !== fromUsers.quota
            ? (fromUsers.excluded / fromUsers.quota) * quota
            : fromUsers.excluded;
        if (excludedQuota > quota) excludedQuota = quota;
      }

      totals.push({
        day,
        quota,
        excludedQuota,
        requests: fromUsers?.requests ?? fromData?.requests ?? 0,
        // 逐日口径：这一天真的有逐账号数据才算拆得出来。
        // 整体 resolved 但某天缺账号明细时，那天的排除额其实是 0。
        excludeResolved:
          excludeSet.size === 0 || (excludeResolved && fromUsers != null),
      });
    }

    if (!totals.length) {
      return {
        success: false,
        totals: [],
        groups: [],
        totalSource: "none",
        complete: false,
        failedDays,
        excludeResolved: false,
        error: "无法读取消费统计，请检查管理员令牌与 New-API-User",
      };
    }

    return {
      success: true,
      totals,
      groups: dataExportOk ? [...groupBuckets.values()] : [],
      totalSource: statOkCount > 0 ? "log-stat" : "data-export",
      complete: failedDays.length === 0,
      failedDays,
      excludeResolved: excludeResolved || excludeSet.size === 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      totals: [],
      groups: [],
      totalSource: "none",
      complete: false,
      failedDays,
      excludeResolved: false,
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

/**
 * 按渠道聚合下游消费，并标出哪些渠道已经被删除。
 *
 * 判定依据两条，缺一不可靠：
 * 1. `GET /api/channel/` 拿存活渠道 id 集合 —— 不在里面的就是删了
 * 2. 日志里的 `channel_name` 为空 —— NewAPI 用 join 填这个字段（`gorm:"->"`），
 *    渠道删掉后 join 不到，名字就空了
 *
 * 存活列表读取失败时退回只看 channel_name，并把 channelListLoaded 标成 false。
 */
export async function fetchDownstreamChannelUsage(
  input: DownstreamAdapterInput & {
    startDay: string;
    endDay: string;
    /** 单页条数，日志量大时调大以减少请求次数 */
    pageSize?: number;
    /** 最多扫多少页，防止跑太久 */
    maxPages?: number;
  },
): Promise<DownstreamChannelUsageResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const pageSize = Math.min(Math.max(input.pageSize ?? 1000, 50), 1000);
  // 有的部署把 page_size 硬限在 100，两万条日志就是 200+ 页，上限给足
  const maxPages = Math.min(Math.max(input.maxPages ?? 400, 1), 2000);

  try {
    // 1) 存活渠道 id
    const aliveIds = new Set<number>();
    let channelListLoaded = false;
    const chRes = await fetchJson(`${base}/api/channel/?p=1&page_size=1000`, {
      method: "GET",
      headers,
      timeoutMs: 30_000,
    });
    if (chRes.ok) {
      const payload = asRecord(chRes.data)?.data;
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(asRecord(payload)?.items)
          ? (asRecord(payload)!.items as unknown[])
          : null;
      if (items) {
        channelListLoaded = true;
        for (const it of items) {
          const id = num(asRecord(it)?.id);
          if (id != null) aliveIds.add(id);
        }
      }
    }

    // 2) 翻消费日志，按渠道归并
    const { start } = shanghaiDayBounds(input.startDay);
    const { end } = shanghaiDayBounds(input.endDay);
    const buckets = new Map<
      number,
      {
        channelName: string;
        quota: number;
        requests: number;
        models: Set<string>;
        firstDay: string;
        lastDay: string;
      }
    >();

    let scanned = 0;
    let total = 0;
    let complete = false;
    /** 服务端可能把 page_size 压小（比如硬限 100），以它实际返回的为准 */
    let effectivePageSize = 0;
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchJson(
        `${base}/api/log/?p=${page}&page_size=${pageSize}&type=2` +
          `&start_timestamp=${start}&end_timestamp=${end}`,
        { method: "GET", headers, timeoutMs: 60_000 },
      );
      if (!res.ok) {
        if (page === 1) {
          return {
            success: false,
            channels: [],
            scanned: 0,
            total: 0,
            complete: false,
            channelListLoaded,
            error: `读取日志失败（HTTP ${res.status}）`,
          };
        }
        break;
      }
      const payload = asRecord(asRecord(res.data)?.data) ?? asRecord(res.data);
      const items = Array.isArray(asRecord(res.data)?.data)
        ? (asRecord(res.data)!.data as unknown[])
        : Array.isArray(payload?.items)
          ? (payload!.items as unknown[])
          : [];
      const pageTotal = num(payload?.total);
      if (pageTotal != null) total = pageTotal;

      // 空页 = 真的到头了
      if (!items.length) {
        complete = true;
        break;
      }
      if (!effectivePageSize) effectivePageSize = items.length;

      for (const row of items) {
        const r = asRecord(row);
        if (!r) continue;
        const channelId = num(r.channel);
        const createdAt = num(r.created_at);
        if (channelId == null || createdAt == null) continue;
        const day = shanghaiDay(createdAt * 1000);
        const quota = num(r.quota) ?? 0;
        const name = typeof r.channel_name === "string" ? r.channel_name : "";
        const model = typeof r.model_name === "string" ? r.model_name : "";

        const b =
          buckets.get(channelId) ||
          {
            channelName: "",
            quota: 0,
            requests: 0,
            models: new Set<string>(),
            firstDay: day,
            lastDay: day,
          };
        b.quota += quota;
        b.requests += 1;
        if (name && !b.channelName) b.channelName = name;
        if (model) b.models.add(model);
        if (day < b.firstDay) b.firstDay = day;
        if (day > b.lastDay) b.lastDay = day;
        buckets.set(channelId, b);
      }

      scanned += items.length;

      // 拿到 total 就以它为准；拿不到就看是否出现短页
      if (total > 0) {
        if (scanned >= total) {
          complete = true;
          break;
        }
      } else if (items.length < effectivePageSize) {
        complete = true;
        break;
      }
    }

    const channels: DownstreamChannelUsageRow[] = [...buckets.entries()].map(
      ([channelId, b]) => ({
        channelId,
        channelName: b.channelName,
        // 有存活列表就信它；没有就退回「名字为空 = 已删除」
        alive: channelListLoaded ? aliveIds.has(channelId) : b.channelName !== "",
        quota: b.quota,
        requests: b.requests,
        models: [...b.models].sort(),
        firstDay: b.firstDay,
        lastDay: b.lastDay,
      }),
    );
    channels.sort((a, b) => b.quota - a.quota);

    return {
      success: true,
      channels,
      scanned,
      total,
      complete: complete || (total > 0 && scanned >= total),
      channelListLoaded,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      channels: [],
      scanned: 0,
      total: 0,
      complete: false,
      channelListLoaded: false,
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

/** 单日的渠道消费聚合 */
export interface DownstreamChannelDayResult {
  success: boolean;
  day: string;
  channels: {
    channelId: number;
    channelName: string;
    quota: number;
    requests: number;
    models: string[];
  }[];
  scanned: number;
  total: number;
  /** 这一天是否翻完了；false 说明被 maxPages 截断，不该记锚点 */
  complete: boolean;
  error?: string;
}

/**
 * 翻某一天的消费日志，按渠道聚合。
 *
 * 按天扫是为了能按天记锚点：过去的日志不会再变，扫过的天下次直接跳过。
 * 这里不判断渠道死活 —— 存活状态是会变的，判定放到读缓存的时候做。
 */
export async function fetchDownstreamChannelDay(
  input: DownstreamAdapterInput & {
    day: string;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<DownstreamChannelDayResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const pageSize = Math.min(Math.max(input.pageSize ?? 1000, 50), 1000);
  const maxPages = Math.min(Math.max(input.maxPages ?? 200, 1), 2000);
  const { start, end } = shanghaiDayBounds(input.day);

  const buckets = new Map<
    number,
    { channelName: string; quota: number; requests: number; models: Set<string> }
  >();
  let scanned = 0;
  let total = 0;
  let complete = false;
  let effectivePageSize = 0;

  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchJson(
        `${base}/api/log/?p=${page}&page_size=${pageSize}&type=2` +
          `&start_timestamp=${start}&end_timestamp=${end}`,
        { method: "GET", headers, timeoutMs: 60_000 },
      );
      if (!res.ok) {
        if (page === 1) {
          return {
            success: false,
            day: input.day,
            channels: [],
            scanned: 0,
            total: 0,
            complete: false,
            error: `读取日志失败（HTTP ${res.status}）`,
          };
        }
        break;
      }

      // HTTP 200 但 success:false —— 不能当成「这天没日志」，否则会落死锚点
      const failure = newApiFailure(res.data);
      if (failure) {
        if (page === 1) {
          return {
            success: false,
            day: input.day,
            channels: [],
            scanned: 0,
            total: 0,
            complete: false,
            error: `读取日志失败：${failure}`,
          };
        }
        break;
      }

      const payload = asRecord(asRecord(res.data)?.data) ?? asRecord(res.data);
      const items = Array.isArray(asRecord(res.data)?.data)
        ? (asRecord(res.data)!.data as unknown[])
        : Array.isArray(payload?.items)
          ? (payload!.items as unknown[])
          : [];
      const pageTotal = num(payload?.total);
      if (pageTotal != null) total = pageTotal;

      if (!items.length) {
        // 第一页就没有任何可解析的条目，且上游也没报总数 —— 分不清是
        // 「这天真没消费」还是「响应结构变了」，按不完整处理、下次重扫。
        complete = page > 1 || total > 0 || Array.isArray(asRecord(res.data)?.data);
        break;
      }
      if (!effectivePageSize) effectivePageSize = items.length;

      for (const row of items) {
        const r = asRecord(row);
        if (!r) continue;
        const channelId = num(r.channel);
        if (channelId == null) continue;
        const quota = num(r.quota) ?? 0;
        const name = typeof r.channel_name === "string" ? r.channel_name : "";
        const model = typeof r.model_name === "string" ? r.model_name : "";

        const b =
          buckets.get(channelId) ||
          { channelName: "", quota: 0, requests: 0, models: new Set<string>() };
        b.quota += quota;
        b.requests += 1;
        if (name && !b.channelName) b.channelName = name;
        if (model) b.models.add(model);
        buckets.set(channelId, b);
      }

      scanned += items.length;
      if (total > 0) {
        if (scanned >= total) {
          complete = true;
          break;
        }
      } else if (items.length < effectivePageSize) {
        complete = true;
        break;
      }
    }

    return {
      success: true,
      day: input.day,
      channels: [...buckets.entries()].map(([channelId, b]) => ({
        channelId,
        channelName: b.channelName,
        quota: b.quota,
        requests: b.requests,
        models: [...b.models].sort(),
      })),
      scanned,
      total,
      complete,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      day: input.day,
      channels: [],
      scanned,
      total,
      complete: false,
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

/** 当前还存活的渠道 id；读不到返回 null（不能据此判断删除） */
export async function fetchDownstreamAliveChannels(
  input: DownstreamAdapterInput,
): Promise<Set<number> | null> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const pageSize = 1000;
  const maxPages = 20;
  try {
    const ids = new Set<number>();
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchJson(
        `${base}/api/channel/?p=${page}&page_size=${pageSize}`,
        { method: "GET", headers, timeoutMs: 30_000 },
      );
      if (!res.ok) return null;
      // HTTP 200 + success:false 也是失败；返回 null 让调用方拒绝判定死活
      if (newApiFailure(res.data)) return null;
      const payload = asRecord(res.data)?.data;
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(asRecord(payload)?.items)
          ? (asRecord(payload)!.items as unknown[])
          : null;
      if (!items) return null;
      for (const it of items) {
        const id = num(asRecord(it)?.id);
        if (id != null) ids.add(id);
      }
      // 服务端可能把 page_size 压小（硬限 100），以实际返回条数判断是否还有下一页
      if (items.length < pageSize) {
        // 一个渠道都没读到：分不清「站点真的没渠道」还是「响应结构变了」。
        // 返回空集会把所有历史渠道判成已删除，宁可不判定。
        if (page === 1 && ids.size === 0) return null;
        return ids;
      }
    }
    return ids;
  } catch {
    return null;
  }
}

