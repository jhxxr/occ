import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  addSub2ApiKeyBoundKey,
  publicBoundKey,
} from "@/lib/sub2api-key/sync";
import { Sub2ApiKeyError } from "@/lib/sub2api-key/client";
import { isSub2ApiKeyType } from "@/lib/provider-kinds";

type Ctx = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  const status = error instanceof Sub2ApiKeyError ? error.status : 400;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "请求失败" },
    { status },
  );
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
    if (!provider) return NextResponse.json({ error: "上游不存在" }, { status: 404 });
    if (!isSub2ApiKeyType(provider.type)) {
      return NextResponse.json({ error: "该上游不是 Sub2API Key 模式" }, { status: 400 });
    }
    const keys = await prisma.upstreamBoundKey.findMany({
      where: { providerId: id, removedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ data: keys.map(publicBoundKey) });
  } catch (error) {
    return errorResponse(error);
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  secret: z.string().trim().min(8).max(2000),
  countAsCost: z.boolean().optional().default(true),
});

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "名称或 API Key 格式不正确" }, { status: 400 });
    }
    const key = await addSub2ApiKeyBoundKey(id, parsed.data);
    return NextResponse.json({ data: publicBoundKey(key) });
  } catch (error) {
    return errorResponse(error);
  }
}
