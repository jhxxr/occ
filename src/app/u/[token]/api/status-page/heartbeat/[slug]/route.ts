import { NextRequest } from "next/server";
import {
  handleKumaHeartbeat,
  kumaOptionsResponse,
} from "@/lib/uptime-kuma-handlers";

export const dynamic = "force-dynamic";

/**
 * GET /u/:token/api/status-page/heartbeat/:slug
 *
 * NewAPI 拼：{基础URL}/api/status-page/heartbeat/{slug}
 * 鉴权看路径里的 token，slug 仅占位。
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string; slug: string }> },
) {
  const { token } = await ctx.params;
  return handleKumaHeartbeat({ authToken: token });
}

export async function OPTIONS() {
  return kumaOptionsResponse();
}
