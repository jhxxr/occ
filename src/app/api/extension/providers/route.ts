import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { relayOnly } from "@/lib/provider-kinds";
import {
  extractExtensionToken,
  findUsableExtensionToken,
} from "@/lib/extension-token";

/**
 * 扩展专用：列出中转上游的「凭证是否在期」状态。
 * 鉴权跟 inject 一样，用注入 token（query / header），不走网页登录 cookie。
 *
 * 扩展拿这份列表画卡片：缺凭证 / 已过期的标红，点一下打开对应面板登录后抓取。
 */

function corsHeaders(req: NextRequest): HeadersInit {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Orbit-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Vary: "Origin",
  };
}

function json(req: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(req) });
}

function extractToken(req: NextRequest): string | null {
  return extractExtensionToken(req);
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function GET(req: NextRequest) {
  if (!extractToken(req)) return json(req, { error: "missing token" }, 400);

  // 含 enabled / 过期判定
  const row = await findUsableExtensionToken(req);
  if (!row) {
    return json(req, { error: "invalid, disabled or expired token" }, 401);
  }

  // 中转上游才有 JWT 可抓；自建站不进列表
  const providers = await prisma.upstreamProvider.findMany({
    where: relayOnly,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      baseUrl: true,
      type: true,
      enabled: true,
      lastSyncAt: true,
      lastError: true,
      tokenExpiresAt: true,
      apiKey: true,
      refreshToken: true,
      accountEmail: true,
    },
  });

  const now = Date.now();
  const SKEW_MS = 5 * 60 * 1000;

  const data = providers.map((p) => {
    const hasAccessToken = !!p.apiKey;
    const hasRefreshToken = !!p.refreshToken;
    const expiresAt = p.tokenExpiresAt ? p.tokenExpiresAt.getTime() : null;
    const expired =
      expiresAt != null ? expiresAt - now <= SKEW_MS : false;

    // 状态：fresh / expiring / expired / missing
    let credentialStatus: "fresh" | "expiring" | "expired" | "missing" =
      "missing";
    if (!hasAccessToken) {
      credentialStatus = "missing";
    } else if (expired) {
      credentialStatus = "expired";
    } else if (expiresAt != null && expiresAt - now < 24 * 3600 * 1000) {
      credentialStatus = "expiring";
    } else {
      credentialStatus = "fresh";
    }

    // 需要人工抓一次：缺 token，或过期且没有 refresh / 邮箱密码可自愈
    const needsGrab =
      credentialStatus === "missing" ||
      (credentialStatus === "expired" && !hasRefreshToken && !p.accountEmail);

    return {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      type: p.type,
      enabled: p.enabled,
      lastSyncAt: p.lastSyncAt,
      lastError: p.lastError,
      tokenExpiresAt: p.tokenExpiresAt,
      hasAccessToken,
      hasRefreshToken,
      hasPasswordLogin: !!p.accountEmail,
      credentialStatus,
      needsGrab,
      // 方便扩展比对当前页 host
      host: (() => {
        try {
          return new URL(p.baseUrl).host.toLowerCase();
        } catch {
          return p.baseUrl.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase() || "";
        }
      })(),
    };
  });

  // 用了一次就记一下，方便设置页看活跃度
  await prisma.extensionInjectToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
  });

  return json(req, {
    ok: true,
    label: row.label,
    tokenBoundProviderId: row.providerId,
    providers: data,
    summary: {
      total: data.length,
      needsGrab: data.filter((d) => d.needsGrab).length,
      fresh: data.filter((d) => d.credentialStatus === "fresh").length,
      expired: data.filter((d) => d.credentialStatus === "expired").length,
      missing: data.filter((d) => d.credentialStatus === "missing").length,
    },
  });
}
