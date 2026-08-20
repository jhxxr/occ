import { NextRequest, NextResponse } from "next/server";
import { getPublicGroupUptime } from "@/lib/public-group-uptime";
import {
  extractBearer,
  GROUP_UPTIME_SCOPE,
  verifyBearerToken,
} from "@/lib/public-api-token";

export const dynamic = "force-dynamic";

/**
 * GET /api/public/group-uptime
 *
 * 对外只读接口：返回中转站「分组」24h Uptime（不含具体渠道/上游）。
 * 鉴权：Authorization: Bearer <token>
 * 也兼容 ?token=（不推荐，仅便于临时调试）
 *
 * 可选 query：
 * - siteName= 按站点显示名过滤
 */
export async function GET(req: NextRequest) {
  try {
    const { authorization, queryToken } = extractBearer(req);
    const auth = await verifyBearerToken(
      authorization,
      queryToken,
      GROUP_UPTIME_SCOPE,
    );
    if (!auth) {
      return NextResponse.json(
        { error: "未授权：请使用有效的 Bearer Token" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="orbit-public", charset="UTF-8"',
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const siteName = req.nextUrl.searchParams.get("siteName") || undefined;
    const data = await getPublicGroupUptime(siteName ? { siteName } : undefined);

    return NextResponse.json(
      {
        data: {
          ...data,
          // 仅确认鉴权成功；不回传 tokenId 等内部标识
          auth: {
            name: auth.name,
            scopes: auth.scopes,
          },
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载分组 Uptime 失败" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}
