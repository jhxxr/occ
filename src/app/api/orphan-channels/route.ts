import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  ORPHAN_COST_MODE,
  detectOrphanChannels,
  listOrphanChannels,
} from "@/lib/orphan-channels";
import { resolvePeriod } from "@/lib/reporting-period";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET：列出已检测到的旧渠道 */
export async function GET(req: NextRequest) {
  const siteId = req.nextUrl.searchParams.get("downstreamId") || undefined;
  try {
    const rows = await listOrphanChannels(siteId);
    return NextResponse.json({
      data: {
        entries: rows,
        summary: {
          total: rows.length,
          unresolved: rows.filter((r) => !r.resolved && !r.ignored).length,
          revenueRmb:
            Math.round(rows.reduce((s, r) => s + r.revenueRmb, 0) * 100) / 100,
          costRmb: Math.round(rows.reduce((s, r) => s + r.costRmb, 0) * 100) / 100,
        },
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 },
    );
  }
}

const detectSchema = z
  .object({
    downstreamId: z.string().min(1).optional(),
    startDay: z.string().regex(DAY, "startDay 需要 YYYY-MM-DD").optional(),
    endDay: z.string().regex(DAY, "endDay 需要 YYYY-MM-DD").optional(),
    period: z.enum(["week", "month"]).optional(),
    offset: z.coerce.number().int().min(-520).max(0).optional(),
    pageSize: z.coerce.number().int().min(50).max(1000).optional(),
    maxPages: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .refine((v) => !!v.startDay === !!v.endDay, {
    message: "自定义区间需要同时提供 startDay 与 endDay",
  });

/** POST：扫描日志，检测已删除渠道的消费 */
export async function POST(req: NextRequest) {
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = detectSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }

  const v = parsed.data;
  try {
    const period =
      v.startDay && v.endDay
        ? { startDay: v.startDay, endDay: v.endDay }
        : resolvePeriod({ period: v.period || "month", offset: v.offset ?? 0 });

    const sites = v.downstreamId
      ? [{ id: v.downstreamId }]
      : await prisma.downstreamSite.findMany({
          where: { enabled: true },
          select: { id: true },
        });

    const results = [];
    for (const s of sites) {
      results.push(
        await detectOrphanChannels(s.id, {
          startDay: period.startDay,
          endDay: period.endDay,
          pageSize: v.pageSize,
          maxPages: v.maxPages,
        }),
      );
    }

    return NextResponse.json({
      data: {
        period,
        results,
        summary: {
          ok: results.filter((r) => r.success).length,
          fail: results.filter((r) => !r.success).length,
          orphans: results.reduce((s, r) => s + r.orphans, 0),
          created: results.reduce((s, r) => s + r.created, 0),
          unresolvedRevenueRmb:
            Math.round(
              results.reduce((s, r) => s + r.unresolvedRevenueRmb, 0) * 100,
            ) / 100,
        },
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "检测失败" },
      { status: 500 },
    );
  }
}

const updateSchema = z.object({
  id: z.string().min(1),
  costMode: z.enum([ORPHAN_COST_MODE.rate, ORPHAN_COST_MODE.amount]).optional(),
  /** ¥ / 每 1 面值 */
  costRate: z.coerce.number().min(0).max(10000).nullish(),
  /** 直接填的总成本 */
  costAmountRmb: z.coerce.number().min(0).nullish(),
  resolved: z.boolean().optional(),
  ignored: z.boolean().optional(),
  note: z.string().max(2000).nullish(),
});

/** PUT：补录/修改成本 */
export async function PUT(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }

  const { id, ...patch } = parsed.data;
  const existing = await prisma.downstreamOrphanChannel.findUnique({
    where: { id },
  });
  if (!existing) {
    return NextResponse.json({ error: "旧渠道记录不存在" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (patch.costMode !== undefined) data.costMode = patch.costMode;
  if (patch.costRate !== undefined) data.costRate = patch.costRate;
  if (patch.costAmountRmb !== undefined) data.costAmountRmb = patch.costAmountRmb;
  if (patch.ignored !== undefined) data.ignored = patch.ignored;
  if (patch.note !== undefined) data.note = patch.note;

  if (patch.resolved !== undefined) {
    data.resolved = patch.resolved;
  } else {
    // 填了成本就视为已确认，省一次点击
    const mode = (data.costMode as string) ?? existing.costMode;
    const rate = patch.costRate !== undefined ? patch.costRate : existing.costRate;
    const amount =
      patch.costAmountRmb !== undefined
        ? patch.costAmountRmb
        : existing.costAmountRmb;
    const filled =
      mode === ORPHAN_COST_MODE.amount ? amount != null : rate != null;
    if (filled) data.resolved = true;
  }

  await prisma.downstreamOrphanChannel.update({ where: { id }, data });
  const rows = await listOrphanChannels(existing.downstreamId);
  return NextResponse.json({
    data: { entry: rows.find((r) => r.id === id) ?? null },
  });
}

/** DELETE：删掉记录（下次检测会重新发现） */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const existing = await prisma.downstreamOrphanChannel.findUnique({
    where: { id },
  });
  if (!existing) {
    return NextResponse.json({ error: "旧渠道记录不存在" }, { status: 404 });
  }
  await prisma.downstreamOrphanChannel.delete({ where: { id } });
  return NextResponse.json({ data: { id } });
}
