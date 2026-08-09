import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getUsdCnyRate } from "@/lib/sync";
import {
  SUB2_PROXY_SETTING_KEY,
  encryptSub2ProxyUrl,
  publicSub2ProxyUrl,
} from "@/lib/sub2/settings";

export async function GET() {
  const [usdCny, all] = await Promise.all([
    getUsdCnyRate(),
    prisma.appSetting.findMany(),
  ]);
  const map = Object.fromEntries(all.map((s) => [s.key, s.value]));
  const sub2ProxyUrl = publicSub2ProxyUrl(map[SUB2_PROXY_SETTING_KEY]);
  delete map[SUB2_PROXY_SETTING_KEY];
  return NextResponse.json({
    data: {
      usdCny,
      sub2ProxyUrl,
      sub2ProxyConfigured: !!sub2ProxyUrl,
      ...map,
    },
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const proxyUrl = body.sub2ProxyUrl;
    if (proxyUrl !== undefined && proxyUrl !== null) {
      if (typeof proxyUrl !== "string") {
        return NextResponse.json({ error: "代理地址格式不正确" }, { status: 400 });
      }
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

    const entries = Object.entries(body).filter(
      ([k]) =>
        typeof k === "string" &&
        k !== "id" &&
        k !== "sub2ProxyUrl" &&
        k !== "sub2ProxyConfigured",
    ) as [string, unknown][];

    for (const [key, value] of entries) {
      if (value == null) continue;
      await prisma.appSetting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
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
