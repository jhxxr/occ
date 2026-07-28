import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getUsdCnyRate } from "@/lib/sync";

export async function GET() {
  const [usdCny, all] = await Promise.all([
    getUsdCnyRate(),
    prisma.appSetting.findMany(),
  ]);
  const map = Object.fromEntries(all.map((s) => [s.key, s.value]));
  return NextResponse.json({
    data: {
      usdCny,
      ...map,
    },
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const entries = Object.entries(body).filter(
      ([k]) => typeof k === "string" && k !== "id",
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
