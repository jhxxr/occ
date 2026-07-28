import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  createManualRecharge,
  listRecharges,
  summarizeRecharges,
  updateRecharge,
} from "@/lib/recharge";

type Ctx = { params: Promise<{ id: string }> };

/** GET — 充值台账列表 + 汇总 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const provider = await prisma.upstreamProvider.findUnique({
      where: { id },
    });
    if (!provider) {
      return NextResponse.json({ error: "上游不存在" }, { status: 404 });
    }
    const [items, summary] = await Promise.all([
      listRecharges(id),
      summarizeRecharges(id),
    ]);
    return NextResponse.json({
      data: {
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          discountRate: provider.discountRate,
          lastBalance: provider.lastBalance,
          lastConsumed: provider.lastConsumed,
        },
        items,
        summary,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载失败" },
      { status: 500 },
    );
  }
}

/**
 * POST — 记录一笔充值
 * body: { paidRmb: number, note?: string, rechargedAt?: string }
 * 额度自动用「当前余额/消耗 − 上次记录」推算（含未勾选 Key 的消耗）
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const paidRmb = Number(body.paidRmb);
    if (!Number.isFinite(paidRmb) || paidRmb < 0) {
      return NextResponse.json({ error: "请填写实付金额（人民币）" }, { status: 400 });
    }
    const row = await createManualRecharge(id, {
      paidRmb,
      note: body.note,
      rechargedAt: body.rechargedAt ? new Date(body.rechargedAt) : undefined,
    });
    const summary = await summarizeRecharges(id);
    return NextResponse.json({ data: { item: row, summary } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "记录失败" },
      { status: 500 },
    );
  }
}

/**
 * PUT — 补填/修正
 * body: { rechargeId, paidRmb?, note?, recalculateCredit? }
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id: providerId } = await ctx.params;
    const body = await req.json();
    if (!body.rechargeId) {
      return NextResponse.json({ error: "rechargeId 必填" }, { status: 400 });
    }
    const existing = await prisma.upstreamRechargeLog.findFirst({
      where: { id: body.rechargeId, providerId },
    });
    if (!existing) {
      return NextResponse.json({ error: "记录不存在" }, { status: 404 });
    }

    // 若要求重算且有最新余额
    const provider = await prisma.upstreamProvider.findUnique({
      where: { id: providerId },
    });
    const patch: {
      paidRmb?: number;
      note?: string;
      recalculateCredit?: boolean;
      balanceAfter?: number;
      consumedAfter?: number;
    } = {
      paidRmb: body.paidRmb != null ? Number(body.paidRmb) : undefined,
      note: body.note,
      recalculateCredit: !!body.recalculateCredit,
    };
    if (body.recalculateCredit && provider) {
      if (provider.lastBalance != null) patch.balanceAfter = provider.lastBalance;
      if (provider.lastConsumed != null) patch.consumedAfter = provider.lastConsumed;
    }

    const row = await updateRecharge(body.rechargeId, patch);
    const summary = await summarizeRecharges(providerId);
    return NextResponse.json({ data: { item: row, summary } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "更新失败" },
      { status: 500 },
    );
  }
}

/** DELETE ?rechargeId= */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { id: providerId } = await ctx.params;
    const rechargeId = req.nextUrl.searchParams.get("rechargeId");
    if (!rechargeId) {
      return NextResponse.json({ error: "rechargeId 必填" }, { status: 400 });
    }
    await prisma.upstreamRechargeLog.deleteMany({
      where: { id: rechargeId, providerId },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "删除失败" },
      { status: 500 },
    );
  }
}
