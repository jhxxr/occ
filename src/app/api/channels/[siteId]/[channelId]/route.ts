import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  deleteChannel,
  setChannelStatus,
  testChannel,
  updateChannel,
} from "@/lib/newapi-channel-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ siteId: string; channelId: string }> };

const editSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  baseUrl: z.string().url().optional(),
  key: z.string().trim().min(1).max(500).optional(),
  models: z.array(z.string().trim().min(1).max(500)).min(1).max(1_000).optional(),
  group: z.string().trim().max(200).optional(),
  priority: z.number().int().min(0).max(100_000).optional(),
  weight: z.number().int().min(0).max(10_000).optional(),
  status: z.number().int().min(0).max(3).optional(),
  autoBan: z.number().int().min(0).max(1).optional(),
  remark: z.string().max(1_000).optional(),
});

async function loadSite(siteId: string) {
  const site = await prisma.downstreamSite.findUnique({
    where: { id: siteId },
    select: { baseUrl: true, adminKey: true, adminUserId: true },
  });
  if (!site) throw new Error("站点不存在");
  return site;
}

function parseChannelId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("渠道 ID 无效");
  return id;
}

/** PATCH：部分字段更新（含自由编辑模型列表）。响应不含任何凭证。 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { siteId, channelId: channelIdRaw } = await ctx.params;
    const site = await loadSite(siteId);
    const channelId = parseChannelId(channelIdRaw);
    const parsed = editSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "参数无效" },
        { status: 400 },
      );
    }
    const updated = await updateChannel(site, channelId, parsed.data);
    return NextResponse.json({ data: updated });
  } catch (error) {
    return respondError(error);
  }
}

/** POST ?action=enable|disable|test：启停快捷操作与测速。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { siteId, channelId: channelIdRaw } = await ctx.params;
    const site = await loadSite(siteId);
    const channelId = parseChannelId(channelIdRaw);
    const action = new URL(req.url).searchParams.get("action");
    if (action === "enable" || action === "disable") {
      const updated = await setChannelStatus(site, channelId, action === "enable");
      return NextResponse.json({ data: updated });
    }
    if (action === "test") {
      const result = await testChannel(site, channelId);
      return NextResponse.json({ data: result });
    }
    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (error) {
    return respondError(error);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { siteId, channelId: channelIdRaw } = await ctx.params;
    const site = await loadSite(siteId);
    const channelId = parseChannelId(channelIdRaw);
    await deleteChannel(site, channelId);
    return NextResponse.json({ data: { deleted: true, channelId } });
  } catch (error) {
    return respondError(error);
  }
}

function respondError(error: unknown) {
  const message = error instanceof Error ? error.message : "渠道操作失败";
  const status = message.includes("站点不存在") ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}
