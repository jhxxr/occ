import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  syncSelfHostedMeta,
  syncSelfHostedGroupUsage,
  getSelfHostedOverview,
  loadAdminProvider,
} from "@/lib/sub2-admin/sync";
import { Sub2AdminError } from "@/lib/sub2-admin/client";

type Ctx = { params: Promise<{ id: string }> };

function handle(e: unknown) {
  if (e instanceof Sub2AdminError) {
    return NextResponse.json(
      { error: e.message, raw: e.raw },
      { status: e.status },
    );
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "失败" },
    { status: 500 },
  );
}

function rangeDays(n: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - n);
  const f = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  return { startDate: f(start), endDate: f(end) };
}

/** GET overview */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const data = await getSelfHostedOverview(id);
    return NextResponse.json({ data });
  } catch (e) {
    return handle(e);
  }
}

/**
 * POST actions:
 *  { action: "sync-meta" }
 *  { action: "sync-usage", startDate?, endDate?, days? }
 *  { action: "update-group", groupId, sellRate?, track?, notes? }
 *  { action: "update-account", accountId, purchaseCostRmb?, track?, notes? }
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await loadAdminProvider(id);
    const body = await req.json();
    const action = body.action as string;

    if (action === "sync-meta") {
      const meta = await syncSelfHostedMeta(id);
      const overview = await getSelfHostedOverview(id);
      return NextResponse.json({ data: { meta, overview } });
    }

    if (action === "sync-usage") {
      const days = Number(body.days || 7);
      const def = rangeDays(Math.min(Math.max(days, 1), 31));
      const startDate = body.startDate || def.startDate;
      const endDate = body.endDate || def.endDate;
      // 先刷 meta 拿最新 sellRate
      await syncSelfHostedMeta(id);
      const usage = await syncSelfHostedGroupUsage(id, {
        startDate,
        endDate,
        maxPages: body.maxPages || 40,
      });
      const overview = await getSelfHostedOverview(id);
      return NextResponse.json({ data: { usage, overview } });
    }

    if (action === "update-group") {
      const groupId = body.groupId as string;
      if (!groupId) {
        return NextResponse.json({ error: "groupId 必填" }, { status: 400 });
      }
      const data: Record<string, unknown> = {};
      if (body.sellRate != null) data.sellRate = Number(body.sellRate);
      if (typeof body.track === "boolean") data.track = body.track;
      if (body.notes !== undefined) data.notes = body.notes;
      const row = await prisma.selfHostedGroup.updateMany({
        where: { id: groupId, providerId: id },
        data,
      });
      if (!row.count) {
        return NextResponse.json({ error: "分组不存在" }, { status: 404 });
      }
      // 若改了 sellRate，重算已有 daily 的 sellRevenueRmb
      if (body.sellRate != null) {
        const g = await prisma.selfHostedGroup.findFirst({
          where: { id: groupId, providerId: id },
        });
        if (g) {
          const dailies = await prisma.selfHostedGroupDaily.findMany({
            where: { providerId: id, remoteGroupId: g.remoteGroupId },
          });
          for (const d of dailies) {
            await prisma.selfHostedGroupDaily.update({
              where: { id: d.id },
              data: {
                sellRevenueRmb: d.officialCost * Number(body.sellRate),
                track: g.track,
              },
            });
          }
        }
      }
      const overview = await getSelfHostedOverview(id);
      return NextResponse.json({ data: overview });
    }

    if (action === "update-account") {
      const accountId = body.accountId as string;
      if (!accountId) {
        return NextResponse.json({ error: "accountId 必填" }, { status: 400 });
      }
      const data: Record<string, unknown> = {};
      if (body.purchaseCostRmb != null) {
        data.purchaseCostRmb = Number(body.purchaseCostRmb);
      }
      if (typeof body.track === "boolean") data.track = body.track;
      if (body.notes !== undefined) data.notes = body.notes;
      const row = await prisma.selfHostedAccount.updateMany({
        where: { id: accountId, providerId: id },
        data,
      });
      if (!row.count) {
        return NextResponse.json({ error: "账号不存在" }, { status: 404 });
      }
      const overview = await getSelfHostedOverview(id);
      return NextResponse.json({ data: overview });
    }

    return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 });
  } catch (e) {
    return handle(e);
  }
}
