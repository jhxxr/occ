import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  applyModelUpdates,
  detectModelUpdates,
} from "@/lib/newapi-channel-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ siteId: string; channelId: string }> };

const modelName = z.string().trim().min(1).max(500);
const requestSchema = z.object({
  addModels: z.array(modelName).max(1_000).default([]),
  removeModels: z.array(modelName).max(1_000).default([]),
  ignoreModels: z.array(modelName).max(1_000).default([]),
});

async function loadSiteAndChannel(siteId: string, channelIdRaw: string) {
  const channelId = Number(channelIdRaw);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    throw new Error("渠道 ID 无效");
  }
  const site = await prisma.downstreamSite.findUnique({
    where: { id: siteId },
    select: { baseUrl: true, adminKey: true, adminUserId: true },
  });
  if (!site) throw new Error("站点不存在");
  return { site, channelId };
}

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "模型确认失败";
  const status = message === "站点不存在" ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}

/** 手动探测：只更新 NewAPI settings 中的待确认列表，不改变当前路由模型。 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { siteId, channelId: channelIdRaw } = await ctx.params;
    const { site, channelId } = await loadSiteAndChannel(siteId, channelIdRaw);
    const data = await detectModelUpdates(site, channelId);
    return NextResponse.json({ data });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { siteId, channelId: channelIdRaw } = await ctx.params;
    const { site, channelId } = await loadSiteAndChannel(siteId, channelIdRaw);
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "参数无效" },
        { status: 400 },
      );
    }

    const applied = await applyModelUpdates(site, channelId, parsed.data);
    // 重新 detect 并读取服务端实际 pending 状态，不假定 apply 已生效。
    const refreshed = await detectModelUpdates(site, channelId);
    return NextResponse.json({ data: { applied, refreshed } });
  } catch (error) {
    return responseError(error);
  }
}
