import { NextRequest, NextResponse } from "next/server";
import { getPublicGroupUptime } from "@/lib/public-group-uptime";
import { verifyPathToken } from "@/lib/public-api-token";
import {
  normalizeStatusSlug,
  toKumaHeartbeat,
} from "@/lib/uptime-kuma-compat";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
} as const;

/**
 * GET /api/status-page/heartbeat/:slug
 *
 * Uptime Kuma heartbeat 兼容。slug = 对外 API Token。
 * 返回 heartbeatList + uptimeList（24h，0–1 小数）。
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: raw } = await ctx.params;
    const slug = normalizeStatusSlug(raw);
    if (!slug) {
      return NextResponse.json(
        { error: "无效的 slug" },
        { status: 400, headers: CORS },
      );
    }

    const auth = await verifyPathToken(slug);
    if (!auth) {
      return NextResponse.json(
        { error: "未授权：请使用有效的 Token 作为 slug" },
        {
          status: 401,
          headers: {
            ...CORS,
            "WWW-Authenticate": 'Bearer realm="orbit-public", charset="UTF-8"',
          },
        },
      );
    }

    const data = await getPublicGroupUptime();
    const body = toKumaHeartbeat(data);
    return NextResponse.json(body, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载心跳失败" },
      { status: 500, headers: CORS },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS,
      "Access-Control-Max-Age": "86400",
    },
  });
}
