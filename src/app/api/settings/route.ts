import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getUsdCnyRate } from "@/lib/sync";
import {
  SUB2_PROXY_SETTING_KEY,
  encryptSub2ProxyUrl,
  publicSub2ProxyUrl,
} from "@/lib/sub2/settings";

const settingsSchema = z
  .object({
    usdCny: z.number().positive().max(100).optional(),
    sub2ProxyUrl: z.string().max(2_000).optional(),
  })
  .strict();

export async function GET() {
  const [usdCny, proxy] = await Promise.all([
    getUsdCnyRate(),
    prisma.appSetting.findUnique({ where: { key: SUB2_PROXY_SETTING_KEY } }),
  ]);
  const sub2ProxyUrl = publicSub2ProxyUrl(proxy?.value);
  return NextResponse.json({
    data: {
      usdCny,
      sub2ProxyUrl,
      sub2ProxyConfigured: !!sub2ProxyUrl,
    },
  });
}

export async function PUT(req: NextRequest) {
  try {
    const parsed = settingsSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "设置参数不合法" },
        { status: 400 },
      );
    }

    const proxyUrl = parsed.data.sub2ProxyUrl;
    if (proxyUrl !== undefined) {
      const value = proxyUrl.trim();
      if (!value) {
        await prisma.appSetting.deleteMany({
          where: { key: SUB2_PROXY_SETTING_KEY },
        });
      } else if (!value.includes("•")) {
        await prisma.appSetting.upsert({
          where: { key: SUB2_PROXY_SETTING_KEY },
          create: {
            key: SUB2_PROXY_SETTING_KEY,
            value: encryptSub2ProxyUrl(value),
          },
          update: { value: encryptSub2ProxyUrl(value) },
        });
      }
    }

    if (parsed.data.usdCny !== undefined) {
      await prisma.appSetting.upsert({
        where: { key: "usdCny" },
        create: { key: "usdCny", value: String(parsed.data.usdCny) },
        update: { value: String(parsed.data.usdCny) },
      });
    }

    const usdCny = await getUsdCnyRate();
    return NextResponse.json({ data: { ok: true, usdCny } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 500 },
    );
  }
}
