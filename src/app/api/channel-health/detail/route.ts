import { NextRequest, NextResponse } from "next/server";
import { getChannelHealthDetail } from "@/lib/channel-health";

export const dynamic = "force-dynamic";

/**
 * GET /api/channel-health/detail?siteId=&channelId=
 * 单渠道详情：最近问题样本 + 24h 模型拆分。
 */
export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get("siteId") || "";
    const channelIdRaw = req.nextUrl.searchParams.get("channelId") || "";
    const channelId = Number(channelIdRaw);
    if (!siteId || !Number.isFinite(channelId) || channelId <= 0) {
      return NextResponse.json(
        { error: "需要 siteId 与 channelId" },
        { status: 400 },
      );
    }
    const data = await getChannelHealthDetail({ siteId, channelId });
    return NextResponse.json({ data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "加载详情失败";
    const status =
      msg.includes("不存在") || msg.includes("未绑定") || msg.includes("解密")
        ? 400
        : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
