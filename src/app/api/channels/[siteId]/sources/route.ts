import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { isSelfHosted } from "@/lib/provider-kinds";

type Ctx = { params: Promise<{ siteId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { siteId } = await ctx.params;
  const site = await prisma.downstreamSite.findUnique({
    where: { id: siteId },
    select: { id: true },
  });
  if (!site) return NextResponse.json({ error: "下游站点不存在" }, { status: 404 });

  const providers = await prisma.upstreamProvider.findMany({
    where: { enabled: true, retiredAt: null },
    select: {
      id: true,
      name: true,
      baseUrl: true,
      type: true,
      apiKey: true,
      boundKeys: {
        where: { removedAt: null, status: "active" },
        select: { id: true, name: true, keyPreview: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    data: providers
      .filter((provider) => !isSelfHosted(provider.type))
      .map((provider) => ({
        providerId: provider.id,
        providerName: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        // 只返回布尔值；顺便实际解密，避免密文存在但 ENCRYPTION_SECRET 已变时
        // 前端错误地显示“主 Key 可用”。明文不离开服务端。
        providerKeyAvailable: Boolean(decryptSecret(provider.apiKey)),
        boundKeys: provider.boundKeys.map((key) => ({
          id: key.id,
          name: key.name || "绑定 Key",
          keyPreview: key.keyPreview,
        })),
      })),
  });
}
