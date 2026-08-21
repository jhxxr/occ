import { NextRequest } from "next/server";
import {
  handleKumaHeartbeat,
  kumaOptionsResponse,
} from "@/lib/uptime-kuma-handlers";

export const dynamic = "force-dynamic";

/**
 * GET /api/status-page/heartbeat/:slug
 *
 * 兼容旧绑定：slug = Token。
 * 推荐：GET /u/<token>/api/status-page/heartbeat/<slug>
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return handleKumaHeartbeat({ authToken: slug });
}

export async function OPTIONS() {
  return kumaOptionsResponse();
}
