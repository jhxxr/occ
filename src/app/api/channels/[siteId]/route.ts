import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { createChannel } from "@/lib/newapi-channel-admin";

type Ctx = { params: Promise<{ siteId: string }> };

const schema = z.object({
  providerId: z.string().min(1),
  boundKeyId: z.string().min(1).optional(),
  apiKeyId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  type: z.number().int().min(1).max(100),
  baseUrl: z.string().url(),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  group: z.string().trim().max(200).default("default"),
  priority: z.number().int().min(0).max(100000).default(0),
  status: z.number().int().min(0).max(3).default(1),
  autoBan: z.number().int().min(0).max(1).default(0),
}).refine((value) => Boolean(value.boundKeyId) !== Boolean(value.apiKeyId), {
  message: "必须且只能选择一个上游 Key",
  path: ["boundKeyId"],
});

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { siteId } = await ctx.params;
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: "渠道参数不合法" }, { status: 400 });
    const input = parsed.data;
    const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
    if (!site || !site.enabled) return NextResponse.json({ error: "下游站点不存在或已停用" }, { status: 404 });
    const provider = await prisma.upstreamProvider.findUnique({ where: { id: input.providerId } });
    if (!provider || !provider.enabled || provider.retiredAt) return NextResponse.json({ error: "上游不存在或不可用" }, { status: 400 });
    let key = "";
    if (input.boundKeyId) {
      const source = await prisma.upstreamBoundKey.findFirst({ where: { id: input.boundKeyId, providerId: provider.id, removedAt: null, status: "active" } });
      if (!source) return NextResponse.json({ error: "绑定 Key 不存在或已停用" }, { status: 400 });
      key = decryptSecret(source.secret);
    } else if (input.apiKeyId) {
      const source = await prisma.upstreamApiKey.findFirst({ where: { id: input.apiKeyId, providerId: provider.id, status: "active" } });
      if (!source) return NextResponse.json({ error: "API Key 不存在或已停用" }, { status: 400 });
      return NextResponse.json({ error: "当前 API Key 记录未保存可用于创建渠道的明文凭据，请选择绑定 Key" }, { status: 409 });
    }
    if (!key) return NextResponse.json({ error: "上游 Key 无法解密" }, { status: 400 });
    const created = await createChannel(site, { ...input, key, baseUrl: input.baseUrl });
    return NextResponse.json({ data: created });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建渠道失败" }, { status: 400 });
  }
}
