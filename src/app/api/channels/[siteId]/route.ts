import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { createChannel } from "@/lib/newapi-channel-admin";

type Ctx = { params: Promise<{ siteId: string }> };

const commonFields = {
  providerId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  type: z.number().int().min(1).max(100),
  baseUrl: z.string().url(),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  group: z.string().trim().max(200).default("default"),
  priority: z.number().int().min(0).max(100000).default(0),
  status: z.number().int().min(0).max(3).default(1),
  autoBan: z.number().int().min(0).max(1).default(0),
};

/** 三种来源互斥，避免同一请求携带多个 Key 后服务端选错。 */
const schema = z.discriminatedUnion("keyMode", [
  z.object({ ...commonFields, keyMode: z.literal("bound"), boundKeyId: z.string().min(1) }).strict(),
  z.object({ ...commonFields, keyMode: z.literal("provider") }).strict(),
  z.object({ ...commonFields, keyMode: z.literal("manual"), manualKey: z.string().trim().min(1).max(2000) }).strict(),
]);

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { siteId } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "渠道参数不合法" },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const [site, provider] = await Promise.all([
      prisma.downstreamSite.findUnique({ where: { id: siteId } }),
      prisma.upstreamProvider.findUnique({ where: { id: input.providerId } }),
    ]);
    if (!site || !site.enabled) {
      return NextResponse.json({ error: "下游站点不存在或已停用" }, { status: 404 });
    }
    if (!provider || !provider.enabled || provider.retiredAt) {
      return NextResponse.json({ error: "上游不存在或不可用" }, { status: 400 });
    }

    let key = "";
    if (input.keyMode === "bound") {
      const source = await prisma.upstreamBoundKey.findFirst({
        where: {
          id: input.boundKeyId,
          providerId: provider.id,
          removedAt: null,
          status: "active",
        },
        select: { secret: true },
      });
      if (!source) {
        return NextResponse.json({ error: "绑定 Key 不存在或已停用" }, { status: 400 });
      }
      key = decryptSecret(source.secret);
      if (!key) {
        return NextResponse.json({ error: "绑定 Key 无法解密，请重新登记或改为手动输入" }, { status: 400 });
      }
    } else if (input.keyMode === "provider") {
      key = decryptSecret(provider.apiKey);
      if (!key) {
        return NextResponse.json({ error: "该上游没有可用的主 Key，请改为手动输入" }, { status: 400 });
      }
    } else {
      // 只在本次请求内存中使用，不落 Orbit 数据库、不写日志。
      key = input.manualKey.trim();
    }

    const created = await createChannel(site, {
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl,
      key,
      models: input.models,
      group: input.group,
      priority: input.priority,
      status: input.status,
      autoBan: input.autoBan,
    });
    return NextResponse.json({ data: created });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建渠道失败" },
      { status: 400 },
    );
  }
}
