import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  createGiftRedemptions,
  syncDownstreamRedemptions,
} from "@/lib/downstream-redemption";
import { syncManagedCreditLedger } from "@/lib/downstream-credit-ledger";
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
  const lots = await prisma.downstreamCreditLot.findMany({
    where: { downstreamId: id, source: { in: ["PRIVATE_DIRECT", "GIFT_CARD_SALE"] } },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
  });
  const users = await prisma.downstreamUserBalance.findMany({
    where: { downstreamId: id, complete: true },
    select: { userId: true, username: true, role: true },
    orderBy: { userId: "asc" },
  });
  return NextResponse.json({ data: { site, codes, lots, users } });
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
    if (body.action === "private-direct") {
      const userId = Number(body.userId);
      const faceValueRmb = Number(body.faceValueRmb);
      const cashBasisRmb = Number(body.cashBasisRmb);
      const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
      const site = await prisma.downstreamSite.findUnique({ where: { id }, select: { quotaPerDollar: true, excludeUserIds: true } });
      if (!site) return NextResponse.json({ error: "站点不存在" }, { status: 404 });
      if (!Number.isInteger(userId) || !(faceValueRmb > 0) || !(cashBasisRmb >= 0) || cashBasisRmb > faceValueRmb || Number.isNaN(occurredAt.getTime())) {
        return NextResponse.json({ error: "请填写有效的用户、面值、到账金额和时间；到账金额不能高于面值" }, { status: 400 });
      }
      let excluded: unknown = [];
      try { excluded = JSON.parse(site.excludeUserIds || "[]"); } catch { /* invalid legacy list is handled as empty */ }
      if (Array.isArray(excluded) && excluded.map(Number).includes(userId)) {
        return NextResponse.json({ error: "剔除账号不能录入私域资金" }, { status: 400 });
      }
      await prisma.downstreamCreditLot.create({
        data: {
          downstreamId: id, userId, source: "PRIVATE_DIRECT", ownership: "PRIVATE",
          originalQuota: faceValueRmb * (site.quotaPerDollar || 500_000),
          remainingQuota: faceValueRmb * (site.quotaPerDollar || 500_000),
          faceValueRmb, cashBasisRmb, occurredAt,
          note: String(body.note || "").slice(0, 500) || null,
        },
      });
      const ledger = await syncManagedCreditLedger(id);
      return NextResponse.json({ data: { ledger } });
    }
    if (body.action === "gift-card-sale") {
      const codeIds = Array.isArray(body.codeIds) ? body.codeIds.map(String).filter(Boolean) : [];
      const cashBasisRmb = Number(body.cashBasisRmb);
      const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
      if (!codeIds.length || !(cashBasisRmb >= 0) || Number.isNaN(occurredAt.getTime())) {
        return NextResponse.json({ error: "请选择兑换码并填写有效到账金额和时间" }, { status: 400 });
      }
      const codes = await prisma.downstreamRedemptionCode.findMany({ where: { id: { in: codeIds }, downstreamId: id, giftManaged: true } });
      if (codes.length !== codeIds.length) return NextResponse.json({ error: "只能登记 Orbit 创建的礼品卡" }, { status: 400 });
      const site = await prisma.downstreamSite.findUnique({ where: { id }, select: { quotaPerDollar: true } });
      if (!site) return NextResponse.json({ error: "站点不存在" }, { status: 404 });
      const faceTotal = codes.reduce((sum, code) => sum + code.quota / (site.quotaPerDollar || 500_000), 0);
      if (cashBasisRmb > faceTotal) return NextResponse.json({ error: "总到账金额不能高于所选礼品卡面值" }, { status: 400 });
      await prisma.$transaction(codes.map((code) => {
        const faceValueRmb = code.quota / (site.quotaPerDollar || 500_000);
        const received = faceTotal ? cashBasisRmb * faceValueRmb / faceTotal : 0;
        return prisma.downstreamCreditLot.upsert({
          where: { ledgerKey: `gift-sale:${id}:${code.remoteId}` },
          create: {
            downstreamId: id, userId: code.usedUserId,
            ledgerKey: `gift-sale:${id}:${code.remoteId}`, source: "GIFT_CARD_SALE", ownership: "PUBLIC",
            originalQuota: code.quota, remainingQuota: code.quota, faceValueRmb, cashBasisRmb: received,
            assumedNoFee: false, occurredAt, note: String(body.note || "").slice(0, 500) || null,
          },
          update: { userId: code.usedUserId, faceValueRmb, cashBasisRmb: received, assumedNoFee: false, occurredAt, note: String(body.note || "").slice(0, 500) || null },
        });
      }));
      const ledger = await syncManagedCreditLedger(id);
      return NextResponse.json({ data: { ledger } });
    }
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
