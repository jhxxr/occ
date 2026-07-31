/**
 * 扩展注入 token 的取用与校验
 *
 * 原本 `!row || !row.enabled` 这个判断散在 inject / providers 三处，
 * 加有效期时很容易漏掉一处 —— 漏掉的那处就是绕过口。集中到这里。
 */

import { prisma } from "@/lib/db";
import { hashExtensionToken } from "@/lib/crypto";

/** 新建 token 的默认有效期 */
export const DEFAULT_TOKEN_TTL_DAYS = 90;
export const MAX_TOKEN_TTL_DAYS = 365;

export interface ExtensionTokenRow {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  providerId: string | null;
  label: string;
  enabled: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 链接里 ?token=oct_… 最方便扩展粘贴；Header 给脚本调用 */
export function extractExtensionToken(req: {
  nextUrl: { searchParams: URLSearchParams };
  headers: Headers;
}): string | null {
  const fromQuery = req.nextUrl.searchParams.get("token");
  const fromHeader =
    req.headers.get("x-orbit-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return (fromQuery || fromHeader || "").trim() || null;
}

export function isTokenExpired(
  row: Pick<ExtensionTokenRow, "expiresAt">,
  now = new Date(),
): boolean {
  return row.expiresAt != null && row.expiresAt.getTime() <= now.getTime();
}

/**
 * 查 token 并判定可用性。
 * 返回 null 表示不可用（不存在 / 已禁用 / 已过期），调用方一律回 401。
 */
export async function findUsableExtensionToken(req: {
  nextUrl: { searchParams: URLSearchParams };
  headers: Headers;
}): Promise<ExtensionTokenRow | null> {
  const token = extractExtensionToken(req);
  if (!token) return null;
  const row = await prisma.extensionInjectToken.findUnique({
    where: { tokenHash: hashExtensionToken(token) },
  });
  if (!row || !row.enabled || isTokenExpired(row)) return null;
  return row;
}

/** 把 expiresInDays 规整成到期时刻；传 0 / null 表示不过期 */
export function resolveExpiry(
  expiresInDays: unknown,
  now = new Date(),
): Date | null {
  if (expiresInDays === null) return null;
  const raw =
    expiresInDays === undefined ? DEFAULT_TOKEN_TTL_DAYS : Number(expiresInDays);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const days = Math.min(Math.floor(raw), MAX_TOKEN_TTL_DAYS);
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
