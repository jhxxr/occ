import { NextRequest } from "next/server";
import {
  handleKumaStatusPage,
  kumaOptionsResponse,
} from "@/lib/uptime-kuma-handlers";

export const dynamic = "force-dynamic";

/**
 * GET /api/status-page/:slug
 *
 * 兼容旧绑定：slug = Token。
 * 推荐改用：
 *   URL  = https://域名/u/<token>
 *   Slug = 任意（如 orbit）
 *   → GET /u/<token>/api/status-page/<slug>
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  return handleKumaStatusPage({ authToken: slug, displaySlug: slug });
}

export async function OPTIONS() {
  return kumaOptionsResponse();
}
