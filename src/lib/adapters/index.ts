import { normalizeBaseUrl } from "@/lib/utils";
import type {
  DownstreamAdapterInput,
  DownstreamFetchResult,
  DownstreamUserRow,
  UpstreamAdapterInput,
  UpstreamFetchResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_QUOTA_PER_DOLLAR = 500_000;
/** Refresh access token this many ms before expiry */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(timer);
  }
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
