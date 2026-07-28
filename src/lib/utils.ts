import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 界面统一人民币展示 */
export function formatRmb(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/**
 * 兼容旧调用：界面不再显示美元符号，数值按人民币格式输出。
 * 若金额本身是美元，请先 toRmb(usd, rate) 再 formatRmb。
 */
export function formatUsd(n: number | null | undefined, digits = 2): string {
  return formatRmb(n, digits);
}

/** 美元面值 × 折算率 → 人民币 */
export function toRmb(
  amountUsd: number | null | undefined,
  ratePerUsd = 1,
): number | null {
  if (amountUsd == null || Number.isNaN(amountUsd)) return null;
  return amountUsd * ratePerUsd;
}

export function formatCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Normalize base URL: strip trailing slash */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
