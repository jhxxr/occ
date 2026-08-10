import { normalizeBaseUrl } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finite(value) ?? 0);
}

export interface Sub2ApiKeyDailyUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  actualCost: number;
  standardCost: number;
}

export interface Sub2ApiKeyUsage {
  balance: number;
  totalActualCost: number;
  todayActualCost: number;
  daily: Sub2ApiKeyDailyUsage[];
  modelStats: unknown[];
}

export class Sub2ApiKeyError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "Sub2ApiKeyError";
    this.status = status;
  }
}

export function parseSub2ApiKeyUsage(payload: unknown): Sub2ApiKeyUsage {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  const total = asRecord(usage?.total);
  const today = asRecord(usage?.today);
  const balance = finite(root?.remaining) ?? finite(root?.balance);
  const totalActualCost = finite(total?.actual_cost);

  if (!root || root.isValid === false) {
    throw new Sub2ApiKeyError("该 API Key 已失效", 401);
  }
  if (balance == null || totalActualCost == null) {
    throw new Sub2ApiKeyError("上游 /v1/usage 返回格式不受支持", 502);
  }

  const daily = Array.isArray(root.daily_usage)
    ? root.daily_usage.flatMap((item) => {
        const row = asRecord(item);
        const day = typeof row?.date === "string" ? row.date : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
        return [{
          day,
          requests: Math.round(nonNegative(row?.requests)),
          inputTokens: Math.round(nonNegative(row?.input_tokens)),
          outputTokens: Math.round(nonNegative(row?.output_tokens)),
          cacheReadTokens: Math.round(nonNegative(row?.cache_read_tokens)),
          totalTokens: Math.round(nonNegative(row?.total_tokens)),
          actualCost: nonNegative(row?.actual_cost),
          standardCost: nonNegative(row?.cost),
        }];
      })
    : [];

  return {
    balance: Math.max(0, balance),
    totalActualCost: Math.max(0, totalActualCost),
    todayActualCost: nonNegative(today?.actual_cost),
    daily,
    modelStats: Array.isArray(root.model_stats) ? root.model_stats.slice(0, 100) : [],
  };
}

export async function fetchSub2ApiKeyUsage(
  baseUrl: string,
  apiKey: string,
): Promise<Sub2ApiKeyUsage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/usage`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Sub2ApiKeyError("API Key 无效或无权查询用量", response.status);
      }
      if (response.status === 429) {
        throw new Sub2ApiKeyError("上游请求过于频繁，请稍后重试", 429);
      }
      throw new Sub2ApiKeyError(`上游用量查询失败 (HTTP ${response.status})`, response.status);
    }
    return parseSub2ApiKeyUsage(payload);
  } catch (error) {
    if (error instanceof Sub2ApiKeyError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Sub2ApiKeyError("上游用量查询超时", 504);
    }
    throw new Sub2ApiKeyError("无法连接上游用量接口", 502);
  } finally {
    clearTimeout(timeout);
  }
}
