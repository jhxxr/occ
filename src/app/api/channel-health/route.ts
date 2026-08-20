import { NextRequest, NextResponse } from "next/server";
import { getChannelHealth } from "@/lib/channel-health";

export const dynamic = "force-dynamic";

/**
 * GET /api/channel-health?siteId=optional
 * 只读已绑定 DSN 的下游 NewAPI 库，聚合渠道健康。
 */
export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get("siteId") || undefined;
    const data = await getChannelHealth(siteId ? { siteId } : undefined);
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载渠道健康失败" },
      { status: 500 },
    );
  }
}
