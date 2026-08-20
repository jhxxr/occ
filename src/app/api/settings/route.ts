import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getUsdCnyRate } from "@/lib/sync";
import {
  getAutoSyncStatus,
  saveAutoSyncConfig,
  MIN_INTERVAL_MINUTES,
} from "@/lib/auto-sync";
import {
  SUB2_PROXY_SETTING_KEY,
  encryptSub2ProxyUrl,
  publicSub2ProxyUrl,
} from "@/lib/sub2/settings";

const settingsSchema = z
  .object({
    usdCny: z.number().positive().max(100).optional(),
    sub2ProxyUrl: z.string().max(2_000).optional(),
    autoSync: z
      .object({
        enabled: z.boolean().optional(),
        // 下限挡在这里：比 15 分钟更密只会给上游加压，一轮本身就要一分多钟
        intervalMinutes: z
          .number()
          .int()
          .min(MIN_INTERVAL_MINUTES, `自动同步间隔不能小于 ${MIN_INTERVAL_MINUTES} 分钟`)
          .max(24 * 60)
          .optional(),
        scope: z.enum(["all", "upstream"]).optional(),
        stealthRandom: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET() {
  const [usdCny, proxy, autoSync] = await Promise.all([
    getUsdCnyRate(),
    prisma.appSetting.findUnique({ where: { key: SUB2_PROXY_SETTING_KEY } }),
    getAutoSyncStatus(),
  ]);
  const sub2ProxyUrl = publicSub2ProxyUrl(proxy?.value);
  return NextResponse.json({
    data: {
      usdCny,
      sub2ProxyUrl,
      sub2ProxyConfigured: !!sub2ProxyUrl,
      autoSync,
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

    if (parsed.data.autoSync) {
      await saveAutoSyncConfig(parsed.data.autoSync);
    }

    const [usdCny, autoSync] = await Promise.all([
      getUsdCnyRate(),
      getAutoSyncStatus(),
    ]);
    return NextResponse.json({ data: { ok: true, usdCny, autoSync } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Save failed" },
      { status: 500 },
    );
  }
}
