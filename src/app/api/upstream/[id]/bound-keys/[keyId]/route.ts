import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  publicBoundKey,
  refreshMolifangProviderAggregate,
  syncMolifangBoundKey,
} from "@/lib/molifang/sync";
import { recomputeCostFlags } from "@/lib/sub2/sync-usage";

type Ctx = { params: Promise<{ id: string; keyId: string }> };

async function loadOwned(id: string, keyId: string) {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!provider) throw new Error("上游不存在");
  if (provider.type !== "MOLIFANG") throw new Error("该上游不支持本地多 Key 绑定");
  const key = await prisma.upstreamBoundKey.findFirst({
    where: { id: keyId, providerId: id, removedAt: null },
  });
  if (!key) throw new Error("绑定 Key 不存在");
  return { provider, key };
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  countAsCost: z.boolean().optional(),
  sync: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id, keyId } = await ctx.params;
    const { provider, key } = await loadOwned(id, keyId);
    if (provider.retiredAt) {
      return NextResponse.json({ error: "该上游已弃用" }, { status: 409 });
    }
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "参数不合法" }, { status: 400 });
    }
    if (parsed.data.sync) {
      const result = await syncMolifangBoundKey(id, keyId);
      await refreshMolifangProviderAggregate(id);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 502 });
      }
    }
    const data = { ...parsed.data };
    delete data.sync;
    const updated = Object.keys(data).length
      ? await prisma.upstreamBoundKey.update({ where: { id: key.id }, data })
      : await prisma.upstreamBoundKey.findUniqueOrThrow({ where: { id: key.id } });
    if (parsed.data.countAsCost !== undefined) await recomputeCostFlags(id);
    await refreshMolifangProviderAggregate(id);
    return NextResponse.json({ data: publicBoundKey(updated) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, keyId } = await ctx.params;
    const { key } = await loadOwned(id, keyId);
    await prisma.upstreamBoundKey.update({
      where: { id: key.id },
      data: {
        status: "removed",
        removedAt: new Date(),
        secret: "",
        // 释放原 Key 的摘要，使误删后仍可重新绑定；历史行继续用当前 ID 归档。
        secretFingerprint: `removed:${key.id}`,
      },
    });
    await refreshMolifangProviderAggregate(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "移除失败" },
      { status: 400 },
    );
  }
}
