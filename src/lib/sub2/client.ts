/**
 * Sub2API authenticated client helpers.
 * Reuses stored email/password + JWT lifecycle from the upstream adapter.
 */

import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { normalizeBaseUrl } from "@/lib/utils";
import { fetchUpstreamBalance, sub2Login, sub2Refresh } from "@/lib/adapters";

export class Sub2Error extends Error {
  status: number;
  raw?: unknown;
  constructor(message: string, status = 400, raw?: unknown) {
    super(message);
    this.name = "Sub2Error";
    this.status = status;
    this.raw = raw;
  }
}

type ProviderRow = {
  id: string;
  baseUrl: string;
  type: string;
  apiKey: string;
  accountEmail: string | null;
  accountPassword: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  discountRate: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function unwrap(data: unknown): unknown {
  const root = asRecord(data);
  if (!root) return data;
  if (root.code === 0 || root.code === "0" || root.code === "success") {
    return root.data !== undefined ? root.data : root;
  }
  return root.data !== undefined ? root.data : root;
}

async function persistTokens(
  id: string,
  tokens: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
  },
) {
  await prisma.upstreamProvider.update({
    where: { id },
    data: {
      apiKey: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken
        ? encryptSecret(tokens.refreshToken)
        : undefined,
      tokenExpiresAt: tokens.expiresAt ?? undefined,
      lastError: null,
    },
  });
}

/** Ensure we have a valid JWT for this Sub2API provider; may login/refresh. */
export async function ensureSub2AccessToken(provider: ProviderRow): Promise<{
  baseUrl: string;
  accessToken: string;
}> {
  if (provider.type !== "SUB2API") {
    throw new Sub2Error("仅 Sub2API 上游支持此操作", 400);
  }

  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  let access = provider.apiKey ? decryptSecret(provider.apiKey) : "";
  let refresh = provider.refreshToken
    ? decryptSecret(provider.refreshToken)
    : null;
  const email = provider.accountEmail;
  const password = provider.accountPassword
    ? decryptSecret(provider.accountPassword)
    : null;

  const expiring =
    provider.tokenExpiresAt != null &&
    provider.tokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  const needAuth = !access || access.startsWith("sk-") || expiring;

  if (needAuth) {
    if (refresh) {
      const r = await sub2Refresh(baseUrl, refresh);
      if (r.ok) {
        access = r.tokens.accessToken;
        refresh = r.tokens.refreshToken;
        await persistTokens(provider.id, {
          accessToken: access,
          refreshToken: refresh,
          expiresAt: r.tokens.expiresAt,
        });
        return { baseUrl, accessToken: access };
      }
    }
    if (email && password) {
      const login = await sub2Login(baseUrl, email, password);
      if (!login.ok) {
        throw new Sub2Error(`自动登录失败：${login.error}`, 401, login.raw);
      }
      access = login.tokens.accessToken;
      refresh = login.tokens.refreshToken;
      await persistTokens(provider.id, {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: login.tokens.expiresAt,
      });
      return { baseUrl, accessToken: access };
    }
    throw new Sub2Error("无有效 JWT，且未绑定邮箱密码，无法调用 Sub2API", 401);
  }

  return { baseUrl, accessToken: access };
}

export async function loadSub2Provider(id: string): Promise<ProviderRow> {
  const p = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!p) throw new Sub2Error("上游不存在", 404);
  return p;
}

/**
 * Authenticated JSON request against Sub2API /api/v1/*
 * Retries once on 401 after forced re-login.
 */
export async function sub2Request<T = unknown>(
  providerId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const provider = await loadSub2Provider(providerId);
  let { baseUrl, accessToken } = await ensureSub2AccessToken(provider);

  const doFetch = async (token: string) => {
    const url = `${baseUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { res, data };
  };

  let { res, data } = await doFetch(accessToken);

  if (res.status === 401 || res.status === 403) {
    // Force re-login
    const fresh = await prisma.upstreamProvider.findUnique({
      where: { id: providerId },
    });
    if (!fresh) throw new Sub2Error("上游不存在", 404);
    // Clear expiry to force login path
    await prisma.upstreamProvider.update({
      where: { id: providerId },
      data: { tokenExpiresAt: new Date(0) },
    });
    const reloaded = await loadSub2Provider(providerId);
    const auth = await ensureSub2AccessToken({
      ...reloaded,
      tokenExpiresAt: new Date(0),
    });
    accessToken = auth.accessToken;
    baseUrl = auth.baseUrl;
    ({ res, data } = await doFetch(accessToken));
  }

  const root = asRecord(data);
  const okHttp = res.ok;
  const okCode =
    !root ||
    root.code === 0 ||
    root.code === "0" ||
    root.code === "success" ||
    root.code === undefined;

  if (!okHttp || (root && "code" in root && !okCode)) {
    const msg =
      (typeof root?.message === "string" && root.message) ||
      `Sub2API 请求失败 (HTTP ${res.status})`;
    throw new Sub2Error(msg, res.status || 400, data);
  }

  return unwrap(data) as T;
}

/** Convenience: also refresh balance snapshot fields using existing engine */
export async function touchBalance(providerId: string) {
  const p = await loadSub2Provider(providerId);
  const apiKey = p.apiKey ? decryptSecret(p.apiKey) : "";
  const accountPassword = p.accountPassword
    ? decryptSecret(p.accountPassword)
    : null;
  const refreshToken = p.refreshToken ? decryptSecret(p.refreshToken) : null;
  return fetchUpstreamBalance({
    baseUrl: p.baseUrl,
    apiKey,
    type: p.type,
    quotaPerDollar: 1,
    accountEmail: p.accountEmail,
    accountPassword,
    refreshToken,
    tokenExpiresAt: p.tokenExpiresAt,
  });
}

// ---------- Domain types (subset of Sub2API) ----------

export interface Sub2Group {
  id: number;
  name: string;
  description?: string;
  platform?: string;
  rate_multiplier: number;
  status?: string;
  subscription_type?: string;
  is_exclusive?: boolean;
  allow_image_generation?: boolean;
  image_rate_multiplier?: number;
  daily_limit_usd?: number;
  weekly_limit_usd?: number;
  monthly_limit_usd?: number;
  rpm_limit?: number;
  [key: string]: unknown;
}

export interface Sub2ApiKey {
  id: number;
  user_id?: number;
  key: string;
  name: string;
  group_id: number | null;
  status: string;
  ip_whitelist?: string[] | null;
  ip_blacklist?: string[] | null;
  last_used_at?: string | null;
  last_used_ip?: string | null;
  quota?: number;
  quota_used?: number;
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
  rate_limit_5h?: number;
  rate_limit_1d?: number;
  rate_limit_7d?: number;
  group?: Sub2Group | null;
  [key: string]: unknown;
}

export async function listGroups(providerId: string): Promise<Sub2Group[]> {
  const data = await sub2Request<Sub2Group[] | { items?: Sub2Group[] }>(
    providerId,
    "/groups/available",
  );
  if (Array.isArray(data)) return data;
  if (data && Array.isArray((data as { items?: Sub2Group[] }).items)) {
    return (data as { items: Sub2Group[] }).items;
  }
  return [];
}

export async function listKeys(
  providerId: string,
  opts: { page?: number; pageSize?: number; status?: string } = {},
): Promise<{ items: Sub2ApiKey[]; total?: number; page?: number; page_size?: number }> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 100;
  const q = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    sort_by: "created_at",
    sort_order: "desc",
  });
  if (opts.status) q.set("status", opts.status);
  const data = await sub2Request<
    | Sub2ApiKey[]
    | { items: Sub2ApiKey[]; total?: number; page?: number; page_size?: number }
  >(providerId, `/keys?${q.toString()}`);

  if (Array.isArray(data)) return { items: data, page, page_size: pageSize };
  return {
    items: data.items || [],
    total: data.total,
    page: data.page ?? page,
    page_size: data.page_size ?? pageSize,
  };
}

export async function createKey(
  providerId: string,
  body: {
    name: string;
    group_id?: number | null;
    custom_key?: string;
    quota?: number;
    expires_in_days?: number;
    ip_whitelist?: string[];
    ip_blacklist?: string[];
    rate_limit_5h?: number;
    rate_limit_1d?: number;
    rate_limit_7d?: number;
  },
): Promise<Sub2ApiKey> {
  return sub2Request<Sub2ApiKey>(providerId, "/keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateKey(
  providerId: string,
  keyId: number,
  body: {
    name?: string;
    group_id?: number | null;
    status?: "active" | "inactive";
    ip_whitelist?: string[] | null;
    ip_blacklist?: string[] | null;
    quota?: number;
    rate_limit_5h?: number;
    rate_limit_1d?: number;
    rate_limit_7d?: number;
  },
): Promise<Sub2ApiKey> {
  return sub2Request<Sub2ApiKey>(providerId, `/keys/${keyId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteKey(
  providerId: string,
  keyId: number,
): Promise<unknown> {
  return sub2Request(providerId, `/keys/${keyId}`, { method: "DELETE" });
}

export interface Sub2KeyUsageStat {
  api_key_id: number;
  today_actual_cost: number;
  total_actual_cost: number;
}

/** POST /usage/dashboard/api-keys-usage  { api_key_ids: number[] } */
export async function fetchKeyUsageStats(
  providerId: string,
  apiKeyIds: number[],
): Promise<Record<string, Sub2KeyUsageStat>> {
  if (!apiKeyIds.length) return {};
  const data = await sub2Request<{
    stats?: Record<string, Sub2KeyUsageStat>;
  }>(providerId, "/usage/dashboard/api-keys-usage", {
    method: "POST",
    body: JSON.stringify({ api_key_ids: apiKeyIds }),
  });
  return data?.stats || {};
}
