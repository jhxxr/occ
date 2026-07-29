import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encryptSecret, hashExtensionToken } from "@/lib/crypto";
import { normalizeBaseUrl } from "@/lib/utils";

function corsHeaders(req: NextRequest): HeadersInit {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Orbit-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
  };
}

function json(req: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(req) });
}

function extractToken(req: NextRequest): string | null {
  const token =
    req.headers.get("x-orbit-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return token?.trim() || null;
}

async function findToken(req: NextRequest) {
  const token = extractToken(req);
  if (!token) return null;
  return prisma.extensionInjectToken.findUnique({
    where: { tokenHash: hashExtensionToken(token) },
  });
}

function hostOf(url: string): string {
  try {
    return new URL(normalizeBaseUrl(url)).host.toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase() || "";
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

/** 扩展探测 token 是否有效 */
export async function GET(req: NextRequest) {
  if (!extractToken(req)) return json(req, { error: "missing token header" }, 400);

  const row = await findToken(req);
  if (!row || !row.enabled) {
    return json(req, { error: "invalid or disabled token" }, 401);
  }

  const provider = row.providerId
    ? await prisma.upstreamProvider.findUnique({
        where: { id: row.providerId },
        select: { id: true, name: true, baseUrl: true, type: true },
      })
    : null;

  return json(req, {
    ok: true,
    label: row.label,
    providerId: row.providerId,
    provider,
    longLived: true,
  });
}

/** 浏览器扩展通过 Header token 推送 JWT / API Key。 */
export async function POST(req: NextRequest) {
  try {
    if (!extractToken(req)) {
      return json(req, { error: "missing inject token header" }, 400);
    }

    const row = await findToken(req);
    if (!row || !row.enabled) {
      return json(req, { error: "invalid or disabled token" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const access =
      (typeof body.accessToken === "string" && body.accessToken.trim()) ||
      (typeof body.apiKey === "string" && body.apiKey.trim()) ||
      (typeof body.jwt === "string" && body.jwt.trim()) ||
      (typeof body.token_value === "string" && body.token_value.trim()) ||
      "";
    if (!access) {
      return json(req, { error: "accessToken / apiKey / jwt required" }, 400);
    }

    const refreshToken =
      typeof body.refreshToken === "string" && body.refreshToken.trim()
        ? body.refreshToken.trim()
        : null;

    let expiresAt: Date | null = null;
    if (typeof body.expiresAt === "string" || typeof body.expiresAt === "number") {
      const date = new Date(body.expiresAt);
      if (!Number.isNaN(date.getTime())) expiresAt = date;
    } else if (typeof body.expiresIn === "number" && body.expiresIn > 0) {
      expiresAt = new Date(Date.now() + body.expiresIn * 1000);
    }

    let providerId =
      row.providerId ||
      (typeof body.providerId === "string" ? body.providerId : null);

    if (row.providerId && body.providerId && body.providerId !== row.providerId) {
      return json(req, { error: "providerId mismatch with inject token" }, 403);
    }

    if (!providerId) {
      const baseHint =
        (typeof body.baseUrl === "string" && body.baseUrl) ||
        (typeof body.host === "string" && body.host) ||
        (typeof body.site === "string" && body.site) ||
        "";
      if (!baseHint) {
        return json(
          req,
          {
            error:
              "此 token 未绑定上游，请在 body 提供 baseUrl/host，或重新生成绑定上游的 token",
          },
          400,
        );
      }
      const host = hostOf(baseHint.startsWith("http") ? baseHint : `https://${baseHint}`);
      const providers = await prisma.upstreamProvider.findMany({
        select: { id: true, baseUrl: true },
      });
      const match = providers.find((provider) => hostOf(provider.baseUrl) === host);
      if (!match) {
        return json(
          req,
          { error: `未找到 baseUrl 匹配 ${host} 的上游，请先在 Orbit 添加该站点` },
          404,
        );
      }
      providerId = match.id;
    }

    const provider = await prisma.upstreamProvider.findUnique({
      where: { id: providerId },
    });
    if (!provider) return json(req, { error: "上游不存在（可能已删除）" }, 404);

    const data: {
      apiKey: string;
      refreshToken?: string;
      tokenExpiresAt?: Date | null;
      lastError: null;
    } = {
      apiKey: encryptSecret(access),
      lastError: null,
    };
    if (refreshToken) data.refreshToken = encryptSecret(refreshToken);
    if (expiresAt) data.tokenExpiresAt = expiresAt;
    if (!expiresAt && provider.type === "SUB2API") data.tokenExpiresAt = null;

    await prisma.upstreamProvider.update({ where: { id: providerId }, data });
    await prisma.extensionInjectToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
    });

    return json(req, {
      ok: true,
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      type: provider.type,
      hasRefreshToken: !!refreshToken,
      tokenExpiresAt: expiresAt,
    });
  } catch (error) {
    return json(
      req,
      { error: error instanceof Error ? error.message : "Inject failed" },
      500,
    );
  }
}
