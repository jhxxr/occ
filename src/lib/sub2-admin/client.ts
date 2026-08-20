/**
 * 自建 Sub2API 管理端客户端（与用户侧 JWT 完全隔离）
 *
 * 鉴权：X-API-Key: admin-xxxx
 * 路由前缀：/api/v1/admin/*
 */

import { normalizeBaseUrl } from "@/lib/utils";
import { hostOf, noteRateLimited, withHostGate } from "@/lib/http/host-gate";

export class Sub2AdminError extends Error {
  status: number;
  raw?: unknown;
  constructor(message: string, status = 400, raw?: unknown) {
    super(message);
    this.name = "Sub2AdminError";
    this.status = status;
    this.raw = raw;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * 剥掉 {code, message, data} 外壳。
 *
 * 面板出错时会回 HTTP 200 + {code: 40001, message: "..."}，两个分支返回同样的
 * 值等于没判断 —— 结果是「取不到数据」被当成同步成功，还会写 lastError: null。
 * 所以非成功码一律抛错。
 */
function unwrap(data: unknown): unknown {
  const root = asRecord(data);
  if (!root) return data;
  const hasCode = "code" in root;
  const ok =
    !hasCode ||
    root.code === 0 ||
    root.code === "0" ||
    root.code === "success" ||
    root.code === true;
  if (!ok) {
    throw new Sub2AdminError(
      (typeof root.message === "string" && root.message) ||
        `Admin API 返回错误码 ${String(root.code)}`,
      502,
      data,
    );
  }
  return root.data !== undefined ? root.data : root;
}

function adminHeaders(adminKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-API-Key": adminKey.trim(),
  };
}

async function adminFetch(
  baseUrl: string,
  adminKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}/api/v1/admin${path.startsWith("/") ? path : `/${path}`}`;
  // 自建站也走统一闸门：同步分组用量要按分组翻页，量不小；
  // 定时同步挂上后不能绕过唯一的限流层。
  return withHostGate(url, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...adminHeaders(adminKey),
          ...(init.headers || {}),
        },
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
          noteRateLimited(hostOf(url), res.headers.get("retry-after"));
        }
        const root = asRecord(data);
        throw new Sub2AdminError(
          (typeof root?.message === "string" && root.message) ||
            `Admin API HTTP ${res.status}`,
          res.status,
          data,
        );
      }
      return unwrap(data);
    } finally {
      clearTimeout(timer);
    }
  });
}

export interface AdminGroup {
  id: number;
  name: string;
  description?: string;
  platform?: string;
  rate_multiplier?: number;
  status?: string;
  is_exclusive?: boolean;
}

export interface AdminAccount {
  id: number;
  name: string;
  platform?: string;
  type?: string;
  status?: string;
  notes?: string | null;
  group_ids?: number[];
  groups?: { id: number; name: string; platform?: string }[];
  last_used_at?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface GroupUsageSummary {
  group_id: number;
  today_cost: number;
  total_cost: number;
}

export interface AdminUsageItem {
  id: number;
  account_id?: number;
  group_id?: number;
  api_key_id?: number;
  model?: string;
  total_cost?: number;
  actual_cost?: number;
  rate_multiplier?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  created_at?: string;
}

export async function adminListGroups(
  baseUrl: string,
  adminKey: string,
): Promise<AdminGroup[]> {
  const data = await adminFetch(baseUrl, adminKey, "/groups?page=1&page_size=200");
  const root = asRecord(data);
  const items = (root?.items as AdminGroup[]) || (Array.isArray(data) ? data : []);
  return items;
}

export async function adminListAccounts(
  baseUrl: string,
  adminKey: string,
): Promise<AdminAccount[]> {
  const data = await adminFetch(
    baseUrl,
    adminKey,
    "/accounts?page=1&page_size=200",
  );
  const root = asRecord(data);
  return (root?.items as AdminAccount[]) || [];
}

export async function adminGroupUsageSummary(
  baseUrl: string,
  adminKey: string,
): Promise<GroupUsageSummary[]> {
  const data = await adminFetch(baseUrl, adminKey, "/groups/usage-summary");
  return Array.isArray(data) ? (data as GroupUsageSummary[]) : [];
}

export async function adminDashboardStats(
  baseUrl: string,
  adminKey: string,
): Promise<Record<string, unknown>> {
  const data = await adminFetch(baseUrl, adminKey, "/dashboard/stats");
  return asRecord(data) || {};
}

/**
 * 拉取管理端使用记录（可按 group_id / 日期过滤）
 *
 * pages 缺省成 1 是危险的：调用方靠它判断还有没有下一页，猜成 1 就只读了
 * 首页 100 条，然后把「部分合计」当成整天的量写回去（数字会悄悄变小）。
 * 所以优先用总数自行推算，并兼容 total_pages 这个别名。
 */
export async function adminListUsage(
  baseUrl: string,
  adminKey: string,
  opts: {
    startDate: string;
    endDate: string;
    groupId?: number;
    accountId?: number;
    page?: number;
    pageSize?: number;
  },
): Promise<{
  items: AdminUsageItem[];
  total: number;
  pages: number;
  /** 上游没给出任何分页总数，pages 是猜的 —— 只能靠返回条数判断是否到底 */
  pagesKnown: boolean;
}> {
  const pageSize = opts.pageSize ?? 100;
  const q = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(pageSize),
    start_date: opts.startDate,
    end_date: opts.endDate,
    timezone: "Asia/Shanghai",
    sort_by: "created_at",
    sort_order: "desc",
  });
  if (opts.groupId) q.set("group_id", String(opts.groupId));
  if (opts.accountId) q.set("account_id", String(opts.accountId));
  const data = await adminFetch(baseUrl, adminKey, `/usage?${q}`);
  const root = asRecord(data);
  const items = (root?.items as AdminUsageItem[]) || [];
  const total = Number(root?.total || 0);
  const reported = Number(root?.pages ?? root?.total_pages ?? 0);
  const derived = total > 0 && pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  const pagesKnown = reported > 0 || derived > 0;
  return {
    items,
    total,
    pages: Math.max(reported, derived, 1),
    pagesKnown,
  };
}

/** 探测 admin key 是否可用 */
export async function adminProbe(
  baseUrl: string,
  adminKey: string,
): Promise<{ ok: true; groups: number; accounts: number; stats: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const [groups, accounts, stats] = await Promise.all([
      adminListGroups(baseUrl, adminKey),
      adminListAccounts(baseUrl, adminKey),
      adminDashboardStats(baseUrl, adminKey),
    ]);
    return {
      ok: true,
      groups: groups.length,
      accounts: accounts.length,
      stats,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
