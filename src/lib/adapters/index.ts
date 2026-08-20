import { normalizeBaseUrl } from "@/lib/utils";
import { fetchSub2 } from "@/lib/sub2/proxy";
import { hostOf, noteRateLimited, withHostGate } from "@/lib/http/host-gate";
import { addDays, enumerateDays, shanghaiDay } from "@/lib/reporting-period";
import type {
  DownstreamAdapterInput,
  DownstreamChannelUsageResult,
  DownstreamChannelUsageRow,
  DownstreamDailyRow,
  DownstreamDailyUsageResult,
  DownstreamFetchResult,
  DownstreamGroupDailyRow,
  DownstreamModelDailyResult,
  DownstreamTopupResult,
  DownstreamTopupRow,
  DownstreamTopupSource,
  DownstreamDailyUserUsageResult,
  DownstreamRedemptionCreateResult,
  DownstreamRedemptionResult,
  DownstreamUserListResult,
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

/** 同主机串行 + 最小间隔 + 429 退避都在 host-gate 里，见那份文件的说明 */
const MAX_RETRIES = 3;

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
  proxyUrl?: string | null,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES, ...rest } = init;
  const host = hostOf(url);

  return withHostGate(url, async () => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      // 超时必须一直armed到响应体读完为止。只盖到响应头的话，一个先回
      // 200、再把 body 吊住的上游会永远停在 res.text()，而同主机的请求
      // 是串行的，于是后面每一条都跟着永久堵死。
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchSub2(
          url,
          { ...rest, signal: controller.signal },
          proxyUrl,
        );

        // 429 / 503：退避后重试，并让同主机的后续请求一起等
        if ((res.status === 429 || res.status === 503) && attempt < retries) {
          const waitMs = noteRateLimited(
            host,
            res.headers.get("retry-after"),
            attempt,
          );
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
        return { ok: res.ok, status: res.status, data, text };
      } finally {
        clearTimeout(timer);
      }
    }
  });
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
  proxyUrl?: string | null,
): Promise<{ ok: true; tokens: Sub2TokenPair } | { ok: false; error: string; raw?: unknown }> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const { ok, status, data } = await fetchJson(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    }, proxyUrl);
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
  proxyUrl?: string | null,
): Promise<{ ok: true; tokens: Sub2TokenPair } | { ok: false; error: string; raw?: unknown }> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const { ok, status, data } = await fetchJson(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, proxyUrl);
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
  proxyUrl?: string | null,
): Promise<UpstreamFetchResult & { unauthorized?: boolean }> {
  const headers = sub2BearerHeaders(accessToken);
  const profilePaths = ["/api/v1/user/profile", "/api/v1/auth/me"];

  let lastError = "Sub2API 未返回可用资料";
  let profileRaw: unknown = null;
  let balance: number | null = null;
  // 累计消费读数。拿不到时**绝不能**当成 0 —— 见 consumedUnknown 的说明。
  let consumed = 0;
  let consumedUnknown = true;

  for (const path of profilePaths) {
    try {
      const { ok, status, data } = await fetchJson(`${base}${path}`, {
        method: "GET",
        headers,
      }, proxyUrl);
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
    }, proxyUrl);
    if (ok) {
      const stats = unwrapSub2(data);
      const spent = num(
        stats.total_actual_cost,
        stats.total_cost,
        stats.TotalActualCost,
      );
      if (spent != null) {
        consumed = spent;
        consumedUnknown = false;
      }
    }
  } catch {
    // 拿不到就保持 consumedUnknown=true：余额还是有效的，这一轮只是不知道累计消费。
    // 以前这里默默留着 consumed=0 并照常返回 success，调用方就把基线覆盖成 0，
    // 下一轮整段累计被当成新增消费记一次成本。
  }

  if (balance == null) {
    return {
      success: false,
      balance: 0,
      consumed: 0,
      consumedUnknown: true,
      error: lastError,
      raw: profileRaw,
    };
  }
  return { success: true, balance, consumed, consumedUnknown, raw: profileRaw };
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
      const refreshed = await sub2Refresh(base, refreshToken, input.proxyUrl);
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
      const logged = await sub2Login(base, email, password, input.proxyUrl);
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

  let result = await fetchSub2ProfileAndStats(base, accessToken, input.proxyUrl);

  // On unauthorized, force re-auth once
  if (!result.success && result.unauthorized) {
    const t = await ensureTokens(true);
    if (t) {
      result = await fetchSub2ProfileAndStats(base, t, input.proxyUrl);
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

function unixSecondsToDate(value: unknown): Date | null {
  const seconds = num(value);
  if (seconds == null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeTopupSource(row: Record<string, unknown>): {
  source: DownstreamTopupSource;
  sourceRaw: string;
} {
  const raw = [row.source, row.topup_source, row.recharge_source, row.type]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const sourceRaw = raw?.trim().slice(0, 100) || "";
  const normalized = sourceRaw.toLowerCase().replace(/[\s-]+/g, "_");
  if (["admin", "admin_manual", "manual_admin", "manage_user"].includes(normalized)) {
    return { source: "ADMIN_MANUAL", sourceRaw };
  }
  if (["redeem", "redeem_code", "redemption", "redemption_code"].includes(normalized)) {
    return { source: "REDEEM_CODE", sourceRaw };
  }
  if (["website", "website_payment", "online_payment"].includes(normalized)) {
    return { source: "WEBSITE_PAYMENT", sourceRaw };
  }
  return { source: "UNKNOWN", sourceRaw };
}

/**
 * 拉取 NewAPI 管理员充值订单。
 *
 * `/api/user/topup` 是一基页码且单页最多 100 条。money 是用户真实支付额；
 * amount 只是到账额度，二者遇到折扣或分组倍率时并不相等。
 */
export async function fetchDownstreamTopups(
  input: DownstreamAdapterInput,
  opts: { maxPages?: number } = {},
): Promise<DownstreamTopupResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 10_000, 10_000));
  const rows: DownstreamTopupRow[] = [];
  let total = 0;

  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchJson(
        `${base}/api/user/topup?p=${page}&page_size=100`,
        { method: "GET", headers, timeoutMs: 30_000 },
      );
      if (!res.ok) {
        const root = asRecord(res.data);
        return {
          success: false,
          rows,
          scanned: rows.length,
          total,
          complete: false,
          error:
            (typeof root?.message === "string" && root.message) ||
            `拉取充值订单失败 (HTTP ${res.status})`,
        };
      }

      const root = asRecord(res.data);
      if (root?.success === false) {
        return {
          success: false,
          rows,
          scanned: rows.length,
          total,
          complete: false,
          error:
            (typeof root.message === "string" && root.message) ||
            "NewAPI 返回充值订单失败",
        };
      }
      const payload = asRecord(root?.data) ?? root;
      const items = payload?.items;
      const remoteTotal = num(payload?.total);
      if (remoteTotal != null && remoteTotal >= 0) total = remoteTotal;
      if (!Array.isArray(items)) {
        return {
          success: false,
          rows,
          scanned: rows.length,
          total,
          complete: false,
          error: "充值订单格式无法解析",
        };
      }

      for (const item of items) {
        const row = asRecord(item);
        const remoteId = num(row?.id);
        const topupUserId = num(row?.user_id);
        if (remoteId == null || topupUserId == null || !row) continue;
        const source = normalizeTopupSource(row);
        rows.push({
          remoteId,
          userId: topupUserId,
          amount: num(row?.amount) ?? 0,
          moneyRmb: num(row?.money) ?? 0,
          tradeNo: typeof row?.trade_no === "string" ? row.trade_no : "",
          paymentMethod:
            typeof row?.payment_method === "string" ? row.payment_method : "",
          paymentProvider:
            typeof row?.payment_provider === "string" ? row.payment_provider : "",
          ...source,
          status: typeof row?.status === "string" ? row.status : String(row?.status ?? ""),
          createdAt: unixSecondsToDate(row?.create_time),
          completedAt: unixSecondsToDate(row?.complete_time),
        });
      }

      if (total > 0 && rows.length >= total) {
        return { success: true, rows, scanned: rows.length, total, complete: true };
      }
      if (items.length === 0 || (items.length < 100 && total === 0)) {
        const inferredTotal = total || rows.length;
        return {
          success: true,
          rows,
          scanned: rows.length,
          total: inferredTotal,
          complete: rows.length >= inferredTotal,
        };
      }
    }

    return {
      success: true,
      rows,
      scanned: rows.length,
      total,
      complete: total > 0 && rows.length >= total,
      error: "充值订单超过同步分页上限",
    };
  } catch (e) {
    return {
      success: false,
      rows,
      scanned: rows.length,
      total,
      complete: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function fetchDownstreamRedemptions(
  input: DownstreamAdapterInput,
  opts: { maxPages?: number } = {},
): Promise<DownstreamRedemptionResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 10_000, 10_000));
  const rows: DownstreamRedemptionResult["rows"] = [];
  let total = 0;

  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchJson(
        `${base}/api/redemption/?p=${page}&page_size=100`,
        { method: "GET", headers, timeoutMs: 30_000 },
      );
      const root = asRecord(res.data);
      if (!res.ok || root?.success === false) {
        return {
          success: false,
          rows,
          scanned: rows.length,
          total,
          complete: false,
          error:
            (typeof root?.message === "string" && root.message) ||
            `拉取兑换码失败 (HTTP ${res.status})`,
        };
      }
      const payload = asRecord(root?.data) ?? root;
      const items = payload?.items;
      const remoteTotal = num(payload?.total);
      if (remoteTotal != null && remoteTotal >= 0) total = remoteTotal;
      if (!Array.isArray(items)) {
        return {
          success: false,
          rows,
          scanned: rows.length,
          total,
          complete: false,
          error: "兑换码列表格式无法解析",
        };
      }

      for (const item of items) {
        const row = asRecord(item);
        const remoteId = num(row?.id);
        if (!row || remoteId == null) continue;
        rows.push({
          remoteId,
          name: typeof row.name === "string" ? row.name : "",
          key: typeof row.key === "string" ? row.key : "",
          quota: num(row.quota) ?? 0,
          status: num(row.status) ?? 0,
          createdAt: unixSecondsToDate(row.created_time),
          redeemedAt: unixSecondsToDate(row.redeemed_time),
          usedUserId: num(row.used_user_id),
          expiredAt: unixSecondsToDate(row.expired_time),
        });
      }

      if (total > 0 && rows.length >= total) {
        return { success: true, rows, scanned: rows.length, total, complete: true };
      }
      if (items.length === 0 || (items.length < 100 && total === 0)) {
        const inferredTotal = total || rows.length;
        return {
          success: true,
          rows,
          scanned: rows.length,
          total: inferredTotal,
          complete: rows.length >= inferredTotal,
        };
      }
    }

    return {
      success: true,
      rows,
      scanned: rows.length,
      total,
      complete: total > 0 && rows.length >= total,
      error: "兑换码超过同步分页上限",
    };
  } catch (error) {
    return {
      success: false,
      rows,
      scanned: rows.length,
      total,
      complete: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createDownstreamRedemptions(
  input: DownstreamAdapterInput,
  payload: { name: string; quota: number; count: number; expiredTime?: number },
): Promise<DownstreamRedemptionCreateResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  if (!payload.name.trim() || payload.name.trim().length > 20) {
    return { success: false, keys: [], error: "兑换码名称需要 1-20 个字符" };
  }
  if (!Number.isInteger(payload.quota) || payload.quota <= 0) {
    return { success: false, keys: [], error: "赠送额度必须是正整数 quota" };
  }
  if (!Number.isInteger(payload.count) || payload.count < 1 || payload.count > 100) {
    return { success: false, keys: [], error: "每次可创建 1-100 个兑换码" };
  }

  try {
    const res = await fetchJson(`${base}/api/redemption/`, {
      method: "POST",
      headers: newApiAdminHeaders(input.adminKey, userId),
      body: JSON.stringify({
        name: payload.name.trim(),
        quota: payload.quota,
        count: payload.count,
        expired_time: payload.expiredTime || 0,
      }),
      timeoutMs: 30_000,
      retries: 0,
    });
    const root = asRecord(res.data);
    const keys = Array.isArray(root?.data)
      ? root.data.filter((value): value is string => typeof value === "string")
      : [];
    if (!res.ok || root?.success === false) {
      return {
        success: false,
        keys,
        error:
          (typeof root?.message === "string" && root.message) ||
          `创建兑换码失败 (HTTP ${res.status})`,
      };
    }
    return { success: true, keys };
  } catch (error) {
    return {
      success: false,
      keys: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** List all NewAPI users for revenue exclusion and balance accounting. */
export async function listDownstreamUsers(
  input: DownstreamAdapterInput,
): Promise<DownstreamUserListResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const quotaPerDollar = input.quotaPerDollar || DEFAULT_QUOTA_PER_DOLLAR;
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const excludeSet = new Set(
    (input.excludeUserIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
  );
  const privateSet = new Set(
    (input.privateUserIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n)),
  );
  const pageSize = 100;
  const maxPages = 1_000;

  try {
    const users: DownstreamUserRow[] = [];
    const seen = new Set<number>();
    let total = 0;
    for (let page = 1; page <= maxPages; page++) {
      const usersRes = await fetchJson(`${base}/api/user/?p=${page}&page_size=${pageSize}`, {
        method: "GET",
        headers,
      });
      if (!usersRes.ok) {
        const root = asRecord(usersRes.data);
        return {
          success: false,
          users,
          scanned: users.length,
          total,
          complete: false,
          error:
            (typeof root?.message === "string" && root.message) ||
            `拉取用户失败 (HTTP ${usersRes.status})`,
        };
      }
      const udata = asRecord(usersRes.data);
      const payload = asRecord(udata?.data) ?? udata;
      const items = (payload?.items ?? payload?.data ?? []) as unknown;
      const remoteTotal = num(payload?.total);
      if (remoteTotal != null && remoteTotal >= 0) total = remoteTotal;
      if (!Array.isArray(items)) {
        return { success: false, users, scanned: users.length, total, complete: false, error: "用户列表格式无法解析" };
      }

      let added = 0;
      for (const row of items) {
        const u = asRecord(row);
        if (!u) continue;
        const id = num(u.id);
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        added++;
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
          isPrivate: !autoExcluded && !excludeSet.has(id) && privateSet.has(id),
        });
      }

      if (total > 0 && users.length >= total) {
        users.sort((a, b) => b.issuedUsd - a.issuedUsd);
        return { success: true, users, scanned: users.length, total, complete: true };
      }
      if (items.length === 0 || added === 0 || (items.length < pageSize && total === 0)) {
        users.sort((a, b) => b.issuedUsd - a.issuedUsd);
        const inferredTotal = total || users.length;
        return { success: true, users, scanned: users.length, total: inferredTotal, complete: users.length >= inferredTotal };
      }
    }
    users.sort((a, b) => b.issuedUsd - a.issuedUsd);
    return { success: true, users, scanned: users.length, total, complete: false, error: "用户数量超过同步分页上限" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, users: [], scanned: 0, total: 0, complete: false, error: msg.includes("abort") ? "Request timeout" : msg };
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
 *
 * 私域拆分同理：privateQuota 靠同一份逐账号数据，拿不到就是 0 +
 * privateResolved=false，别把「拆不出来」当成「没有私域」。
 */
export async function fetchDownstreamDailyUsage(
  input: DownstreamAdapterInput & {
    startDay: string;
    endDay: string;
    /** 被排除账号的用户名（测试号）；逐账号拆分要用名字而不是 id */
    excludeUsernames?: string[];
    /** 私域账号的用户名（自己推广的） */
    privateUsernames?: string[];
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

  try {
    const rangeStart = shanghaiDayBounds(input.startDay).start;
    const rangeEnd = shanghaiDayBounds(input.endDay).end;

    // 1) 逐账号日消费：唯一能把测试号和私域拆出来的来源
    const perUser = new Map<
      string,
      { quota: number; excluded: number; private: number; requests: number }
    >();
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
            perUser.get(day) || { quota: 0, excluded: 0, private: 0, requests: 0 };
          bucket.quota += quota;
          bucket.requests += count;
          // 排除优先：同时在两个名单里时算测试号，不进私域
          if (excludeSet.has(username)) bucket.excluded += quota;
          else if (privateSet.has(username)) bucket.private += quota;
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
      // 私域额同理缩放，并且封顶在「付费部分」而不是全站 ——
      // 私域是收入的子集，超过付费额就会把公共池算成负数。
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
        requests: fromUsers?.requests ?? fromData?.requests ?? 0,
        // 逐日口径：这一天真的有逐账号数据才算拆得出来。
        // 整体 resolved 但某天缺账号明细时，那天的排除额其实是 0。
        excludeResolved:
          excludeSet.size === 0 || (excludeResolved && fromUsers != null),
        privateResolved:
          privateSet.size === 0 || (excludeResolved && fromUsers != null),
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
        privateResolved: false,
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
      privateResolved: excludeResolved || privateSet.size === 0,
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
      privateResolved: false,
      error: msg.includes("abort") ? "Request timeout" : msg,
    };
  }
}

export async function fetchDownstreamDailyUserUsage(
  input: DownstreamAdapterInput & { startDay: string; endDay: string },
): Promise<DownstreamDailyUserUsageResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  try {
    const rangeStart = shanghaiDayBounds(input.startDay).start;
    const rangeEnd = shanghaiDayBounds(input.endDay).end;
    const res = await fetchJson(
      `${base}/api/data/users?start_timestamp=${rangeStart}&end_timestamp=${rangeEnd}`,
      { method: "GET", headers, timeoutMs: 30_000 },
    );
    if (!res.ok) return { success: false, rows: [], complete: false, error: `逐用户消费拉取失败 (HTTP ${res.status})` };
    const data = asRecord(res.data)?.data;
    if (!Array.isArray(data)) return { success: false, rows: [], complete: false, error: "逐用户消费格式无法解析" };
    const rows = [];
    for (const item of data) {
      const row = asRecord(item);
      const createdAt = num(row?.created_at);
      const username = typeof row?.username === "string" ? row.username : "";
      if (createdAt == null || !username) continue;
      const day = shanghaiDay(createdAt * 1000);
      if (day < input.startDay || day > input.endDay) continue;
      rows.push({ day, occurredAt: new Date(createdAt * 1000), username, quota: num(row?.quota) ?? 0, requests: num(row?.count) ?? 0 });
    }
    return { success: true, rows, complete: data.length === 0 ? false : true, error: data.length === 0 ? "逐用户消费为空，无法执行赠送额度分摊" : undefined };
  } catch (e) {
    return { success: false, rows: [], complete: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** NewAPI /api/log 服务端封顶 100 条/页，请求更大也不会生效 */
const MODEL_DAILY_PAGE_SIZE = 100;
/** 单天翻页上限，防止 total 异常时死循环（100 × 500 = 5 万条/天） */
const MODEL_DAILY_MAX_PAGES = 500;

/**
 * 按天扫描 /api/log 逐条日志，按 (天 × 模型 × 归属) 聚合。
 *
 * 这是 NewAPI 唯二同时返回 username 和 model_name 的入口 ——
 * 拿不到逐账号模型消费，上下游成本就只能按收入占比摊。
 * 拿到之后，报表可以用模型级成本率算私域 / 公共各自的真实成本。
 *
 * 返回三组数据，同一 (天, 模型) 下三行同时落库：
 * - totals  ：全站所有付费用户在该模型上的消费
 * - private ：私域用户在该模型上的消费
 * - public  ：公共池用户在该模型上的消费
 */
export async function fetchDownstreamModelDaily(
  input: DownstreamAdapterInput & {
    startDay: string;
    endDay: string;
    excludeUsernames?: string[];
    privateUsernames?: string[];
  },
): Promise<DownstreamModelDailyResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  const userId = input.adminUserId && input.adminUserId > 0 ? input.adminUserId : 1;
  const headers = newApiAdminHeaders(input.adminKey, userId);
  const days = enumerateDays(input.startDay, input.endDay);
  const failedDays: string[] = [];

  if (!days.length) {
    return { success: false, rows: [], scanned: 0, complete: false, resolved: false, failedDays: [], error: "日期区间为空" };
  }

  const excludeSet = new Set(
    (input.excludeUsernames || []).map((n) => n.trim()).filter(Boolean),
  );
  const privateSet = new Set(
    (input.privateUsernames || []).map((n) => n.trim()).filter(Boolean),
  );

  // (天, 模型).TOTAL / PRIVATE / PUBLIC
  const buckets = new Map<
    string,
    { privateQuota: number; publicQuota: number; privateReq: number; publicReq: number }
  >();
  let scanned = 0;
  let resolved = false;

  try {
    for (const day of days) {
      const { start, end } = shanghaiDayBounds(day);
      let page = 1;
      let dayComplete = false;
      let dayScanned = 0;
      let dayTotal: number | null = null;
      let dayFetched = 0;

      // 这个 NewAPI 把 page_size 硬封在 100，请求 2000 也只回 100 条 ——
      // 所以翻页必须靠响应里的 total + 实际返回条数推进，不能拿请求的 page_size 判断结束。
      while (!dayComplete) {
        if (page > MODEL_DAILY_MAX_PAGES) {
          failedDays.push(day);
          break;
        }
        const url = `${base}/api/log/?p=${page}&page_size=${MODEL_DAILY_PAGE_SIZE}&start_timestamp=${start}&end_timestamp=${end}`;
        const res = await fetchJson(url, { method: "GET", headers, timeoutMs: 25_000 });
        if (!res.ok) {
          failedDays.push(day);
          break;
        }
        const payload = asRecord(res.data);
        const data = asRecord(payload?.data);
        const items: unknown[] = Array.isArray(data?.items)
          ? (data.items as unknown[])
          : Array.isArray(payload?.data)
            ? (payload.data as unknown[])
            : [];
        if (dayTotal === null) dayTotal = num(data?.total) ?? null;
        if (!Array.isArray(items) || items.length === 0) {
          if (page === 1 && dayFetched === 0) failedDays.push(day);
          break;
        }
        dayFetched += items.length;
        if (page === 1 && items.length > 0) resolved = true;

        for (const item of items) {
          const r = asRecord(item);
          if (!r) continue;
          const username = typeof r.username === "string" ? r.username : "";
          // 跳过超管和测试号
          if (!username || excludeSet.has(username)) continue;
          const model = typeof r.model_name === "string" ? r.model_name : "";
          if (!model) continue;
          const quota = num(r.quota) ?? 0;
          if (quota <= 0) continue;

          const bk = `${day}|${model}`;
          const cur = buckets.get(bk) || {
            privateQuota: 0,
            publicQuota: 0,
            privateReq: 0,
            publicReq: 0,
          };
          const isPrivate = privateSet.has(username);
          if (isPrivate) {
            cur.privateQuota += quota;
            cur.privateReq++;
          } else {
            cur.publicQuota += quota;
            cur.publicReq++;
          }
          buckets.set(bk, cur);
          dayScanned++;
        }

        // total 优先：拉满就停；没有 total 时退化成"返回不足一页即结束"
        if (dayTotal !== null && dayTotal > 0) {
          dayComplete = dayFetched >= dayTotal;
        } else {
          dayComplete = items.length < MODEL_DAILY_PAGE_SIZE;
        }
        if (!dayComplete) page++;
      }
      scanned += dayScanned;
    }

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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      rows: [],
      scanned,
      complete: false,
      resolved,
      failedDays,
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

