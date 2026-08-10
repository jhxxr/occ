import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { RECHARGE_GRACE_COOKIE, verifyRechargeGraceToken } from "@/lib/recharge-security";
import { createManagedRecharge, syncDownstreamUserBalances } from "@/lib/downstream-recharge";

type Ctx = { params: Promise<{ id: string }> };

async function operator(): Promise<string | null> {
  const store = await cookies();
  const session = verifySessionToken(store.get(COOKIE_NAME)?.value);
  if (!session) return null;
  if (!verifyRechargeGraceToken(store.get(RECHARGE_GRACE_COOKIE)?.value, session.u)) return null;
  return session.u;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const site = await prisma.downstreamSite.findUnique({ where: { id }, select: { id: true, name: true, balanceLastSyncAt: true, balanceSyncError: true, excludeUserIds: true, privateUserIds: true } });
  if (!site) return NextResponse.json({ error: "站点不存在" }, { status: 404 });
  const operations = await prisma.downstreamRechargeOperation.findMany({ where: { downstreamId: id }, orderBy: { createdAt: "desc" }, take: 100 });
  const balances = await prisma.downstreamUserBalance.findMany({ where: { downstreamId: id }, orderBy: { quota: "desc" } });
  return NextResponse.json({ data: { site, operations, balances } });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const username = await operator();
  if (!username) return NextResponse.json({ error: "请先输入充值安全密码" }, { status: 403 });
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const result = await createManagedRecharge({
      downstreamId: id,
      userId: Number(body.userId),
      paidRmb: Number(body.paidRmb),
      creditedRmb: Number(body.creditedRmb),
      idempotencyKey: String(body.idempotencyKey || ""),
      operator: username,
      note: typeof body.note === "string" ? body.note.slice(0, 1000) : undefined,
    });
    return NextResponse.json({ data: result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "充值失败" }, { status: 400 });
  }
}

export async function PUT(_req: NextRequest, ctx: Ctx) {
  void _req;
  const username = await operator();
  if (!username) return NextResponse.json({ error: "请先输入充值安全密码" }, { status: 403 });
  const { id } = await ctx.params;
  try {
    const result = await syncDownstreamUserBalances(id);
    return NextResponse.json({ data: { observedAt: result.observedAt, count: result.users.length } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "余额同步失败" }, { status: 400 });
  }
}
