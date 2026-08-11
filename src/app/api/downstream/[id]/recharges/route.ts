import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  createGiftRedemptions,
  syncDownstreamRedemptions,
} from "@/lib/downstream-redemption";
import {
  checkGiftIssuanceAllowed,
  recordGiftIssuance,
  validateGiftIssuanceValue,
} from "@/lib/gift-issuance-limit";

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
  const site = await prisma.downstreamSite.findUnique({
    where: { id },
    select: { id: true, name: true, baseUrl: true, quotaPerDollar: true },
  });
  if (!site) return NextResponse.json({ error: "站点不存在" }, { status: 404 });
  const codes = await prisma.downstreamRedemptionCode.findMany({
    where: { downstreamId: id },
    orderBy: [{ createdAtRemote: "desc" }, { remoteId: "desc" }],
    take: 200,
  });
  return NextResponse.json({ data: { site, codes } });
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
    const body = await req.json();
    const quota = Number(body.quota);
    const count = Number(body.count);
    const site = await prisma.downstreamSite.findUnique({
      where: { id },
      select: { quotaPerDollar: true },
    });
    if (!site) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    validateGiftIssuanceValue({
      quota,
      count,
      quotaPerUnit: site.quotaPerDollar,
    });
    const verdict = checkGiftIssuanceAllowed();
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: `创建请求过于频繁，请 ${verdict.retryAfterSec} 秒后再试` },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } },
      );
    }
    recordGiftIssuance();
    const result = await createGiftRedemptions({
      downstreamId: id,
      name: String(body.name || "").slice(0, 20),
      quota,
      count,
      expiredTime: body.expiredTime ? Number(body.expiredTime) : undefined,
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    const keys = error instanceof Error && "keys" in error
      ? (error as Error & { keys?: string[] }).keys
      : undefined;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建兑换码失败", keys },
      { status: 400 },
    );
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  if (!sameOriginJson(req)) {
    return NextResponse.json({ error: "请求来源或格式无效" }, { status: 403 });
  }
  if (!(await authenticated())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const result = await syncDownstreamRedemptions(id);
    return NextResponse.json({ data: { syncedAt: result.syncedAt, count: result.rows.length } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "同步兑换码失败" },
      { status: 400 },
    );
  }
}
