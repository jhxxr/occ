import { NextRequest } from "next/server";
import {
  handleKumaStatusPage,
  kumaOptionsResponse,
} from "@/lib/uptime-kuma-handlers";

export const dynamic = "force-dynamic";

/**
 * GET /u/:token/api/status-page/:slug
 *
 * NewAPI Uptime Kuma 绑定（推荐）：
 *   基础 URL = https://你的控制台域名/u/<token>
 *   别名 slug = 任意（如 orbit）
 *
 * NewAPI 实际请求：
 *   {基础URL}/api/status-page/{slug}
 *   {基础URL}/api/status-page/heartbeat/{slug}
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string; slug: string }> },
) {
  const { token, slug } = await ctx.params;
  return handleKumaStatusPage({ authToken: token, displaySlug: slug });
}

export async function OPTIONS() {
  return kumaOptionsResponse();
}
