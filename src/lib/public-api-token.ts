import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";

export const GROUP_UPTIME_SCOPE = "group-uptime:read";
export const TOKEN_PREFIX = "occ_";

export interface PublicApiTokenPublic {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedPublicApiToken extends PublicApiTokenPublic {
  /** 明文 token，仅创建响应返回一次 */
  token: string;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw.trim()).digest("hex");
}

function parseScopes(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toPublic(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string;
  enabled: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PublicApiTokenPublic {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: parseScopes(row.scopes),
    enabled: row.enabled,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 生成 occ_ + 43 字符 base64url 随机串 */
export function generateRawToken(): string {
  const body = randomBytes(32).toString("base64url");
  return `${TOKEN_PREFIX}${body}`;
}

export function publicPrefixOf(raw: string): string {
  const t = raw.trim();
  // occ_ + 前 8 位
  return t.slice(0, Math.min(t.length, TOKEN_PREFIX.length + 8));
}

export async function listPublicApiTokens(): Promise<PublicApiTokenPublic[]> {
  const rows = await prisma.publicApiToken.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toPublic);
}

export async function createPublicApiToken(input: {
  name: string;
  scopes?: string[];
  expiresAt?: Date | null;
}): Promise<CreatedPublicApiToken> {
  const name = input.name.trim();
  if (!name) throw new Error("请填写 Token 名称");
  if (name.length > 200) throw new Error("名称过长");

  const scopes = (input.scopes?.length ? input.scopes : [GROUP_UPTIME_SCOPE])
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) scopes.push(GROUP_UPTIME_SCOPE);

  const token = generateRawToken();
  const row = await prisma.publicApiToken.create({
    data: {
      name,
      tokenHash: hashToken(token),
      tokenPrefix: publicPrefixOf(token),
      scopes: scopes.join(","),
      expiresAt: input.expiresAt ?? null,
    },
  });

  return { ...toPublic(row), token };
}

export async function revokePublicApiToken(id: string): Promise<PublicApiTokenPublic> {
  const existing = await prisma.publicApiToken.findUnique({ where: { id } });
  if (!existing) throw new Error("Token 不存在");
  if (existing.revokedAt) return toPublic(existing);

  const row = await prisma.publicApiToken.update({
    where: { id },
    data: {
      enabled: false,
      revokedAt: new Date(),
    },
  });
  return toPublic(row);
}

export async function setPublicApiTokenEnabled(
  id: string,
  enabled: boolean,
): Promise<PublicApiTokenPublic> {
  const existing = await prisma.publicApiToken.findUnique({ where: { id } });
  if (!existing) throw new Error("Token 不存在");
  if (existing.revokedAt) throw new Error("已吊销的 Token 不能重新启用，请新建");

  const row = await prisma.publicApiToken.update({
    where: { id },
    data: { enabled },
  });
  return toPublic(row);
}

export async function deletePublicApiToken(id: string): Promise<void> {
  await prisma.publicApiToken.delete({ where: { id } });
}

/**
 * 从 Authorization: Bearer <token> 或 ?token= 校验。
 * 成功返回 token 元数据；失败返回 null。
 */
export async function verifyBearerToken(
  authorizationHeader: string | null,
  queryToken?: string | null,
  requiredScope = GROUP_UPTIME_SCOPE,
): Promise<PublicApiTokenPublic | null> {
  let raw = "";
  if (authorizationHeader) {
    const m = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) raw = m[1].trim();
  }
  if (!raw && queryToken) raw = queryToken.trim();
  if (!raw) return null;

  const hash = hashToken(raw);
  const row = await prisma.publicApiToken.findUnique({
    where: { tokenHash: hash },
  });
  if (!row) return null;

  // 额外 constant-time 比较 hash（防意外）
  try {
    const a = Buffer.from(row.tokenHash, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  if (!row.enabled || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const scopes = parseScopes(row.scopes);
  if (!scopes.includes(requiredScope) && !scopes.includes("*")) return null;

  // 异步更新 lastUsedAt，不阻塞主路径
  void prisma.publicApiToken
    .update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  return toPublic(row);
}

/** 从请求头解析 Bearer */
export function extractBearer(req: {
  headers: { get(name: string): string | null };
  nextUrl?: { searchParams: URLSearchParams };
}): { authorization: string | null; queryToken: string | null } {
  return {
    authorization: req.headers.get("authorization"),
    queryToken: req.nextUrl?.searchParams.get("token") ?? null,
  };
}
