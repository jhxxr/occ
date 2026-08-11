import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  applyOpeningPrepaid,
  previewOpeningPrepaid,
} from "@/lib/opening-prepaid";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function sameOriginJson(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const contentType = req.headers.get("content-type") || "";
  if (!origin || !contentType.toLowerCase().startsWith("application/json")) return false;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

async function authenticated(): Promise<boolean> {
  const store = await cookies();
  return !!verifySessionToken(store.get(COOKIE_NAME)?.value);
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ data: await previewOpeningPrepaid(id) });
  } catch (error) {
    const site = await prisma.downstreamSite.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        balanceLastSyncAt: true,
        balanceSyncError: true,
      },
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "无法生成期初充值预览",
        data: site,
      },
      { status: site ? 409 : 404 },
    );
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  if (!sameOriginJson(req)) {
    return NextResponse.json({ error: "请求来源或格式无效" }, { status: 403 });
  }
  if (!(await authenticated())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ data: await applyOpeningPrepaid(id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成期初充值失败" },
      { status: 400 },
    );
  }
}
