import { NextResponse } from "next/server";
import { getPublicGroupUptime } from "@/lib/public-group-uptime";
import { verifyPathToken } from "@/lib/public-api-token";
import {
  normalizeStatusSlug,
  toKumaHeartbeat,
  toKumaStatusPage,
} from "@/lib/uptime-kuma-compat";

export const KUMA_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
} as const;

export function kumaOptionsResponse() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...KUMA_CORS,
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * 鉴权 token 来源：
 * 1) 路径前缀 /u/<token>/...（推荐，配合 NewAPI「基础 URL」）
 * 2) 路径 slug /api/status-page/<token>（旧）
 */
export async function handleKumaStatusPage(opts: {
  authToken: string | null | undefined;
  /** 写入 config.slug 的展示值；鉴权失败时不使用 */
  displaySlug?: string | null;
}) {
  try {
    const token = normalizeStatusSlug(opts.authToken);
    if (!token) {
      return NextResponse.json(
        { error: "无效的 Token" },
        { status: 400, headers: KUMA_CORS },
      );
    }

    const auth = await verifyPathToken(token);
    if (!auth) {
      return NextResponse.json(
        { error: "未授权：请使用有效的 Token" },
        {
          status: 401,
          headers: {
            ...KUMA_CORS,
            "WWW-Authenticate": 'Bearer realm="orbit-public", charset="UTF-8"',
          },
        },
      );
    }

    const display =
      normalizeStatusSlug(opts.displaySlug) || token;
    const data = await getPublicGroupUptime();
    const body = toKumaStatusPage(data, display);
    return NextResponse.json(body, { headers: KUMA_CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载状态页失败" },
      { status: 500, headers: KUMA_CORS },
    );
  }
}

export async function handleKumaHeartbeat(opts: {
  authToken: string | null | undefined;
}) {
  try {
    const token = normalizeStatusSlug(opts.authToken);
    if (!token) {
      return NextResponse.json(
        { error: "无效的 Token" },
        { status: 400, headers: KUMA_CORS },
      );
    }

    const auth = await verifyPathToken(token);
    if (!auth) {
      return NextResponse.json(
        { error: "未授权：请使用有效的 Token" },
        {
          status: 401,
          headers: {
            ...KUMA_CORS,
            "WWW-Authenticate": 'Bearer realm="orbit-public", charset="UTF-8"',
          },
        },
      );
    }

    const data = await getPublicGroupUptime();
    const body = toKumaHeartbeat(data);
    return NextResponse.json(body, { headers: KUMA_CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载心跳失败" },
      { status: 500, headers: KUMA_CORS },
    );
  }
}
