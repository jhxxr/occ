import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { COST_MODE, COST_STATUS, summarizeCosts } from "@/lib/operating-cost";
import { resolvePeriod, shanghaiDay } from "@/lib/reporting-period";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY, "日期需要 YYYY-MM-DD");

const createSchema = z
  .object({
    name: z.string().trim().min(1, "名称必填").max(200),
    amountRmb: z.coerce.number().min(0, "金额不能为负"),
    mode: z.enum([COST_MODE.oneTime, COST_MODE.period]).default(COST_MODE.oneTime),
    startDay: day.optional(),
    plannedEndDay: day.nullish(),
    actualEndDay: day.nullish(),
    category: z.string().trim().max(30).default("self-hosted"),
    providerId: z.string().trim().max(40).nullish(),
    accountId: z.string().trim().max(40).nullish(),
    note: z.string().max(2000).nullish(),
  })
  .refine(
    (v) =>
      v.mode !== COST_MODE.period ||
      !v.plannedEndDay ||
      !v.startDay ||
      v.plannedEndDay >= v.startDay,
    { message: "计划结束日不能早于开始日" },
  )
  .refine(
    (v) =>
      !v.actualEndDay || !v.startDay || v.actualEndDay >= v.startDay,
    { message: "实际结束日不能早于开始日" },
  );

const updateSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  amountRmb: z.coerce.number().min(0).optional(),
  mode: z.enum([COST_MODE.oneTime, COST_MODE.period]).optional(),
  startDay: day.optional(),
  plannedEndDay: day.nullish(),
  /** 账号被风控停用时填这里：整笔成本压缩到实际存活区间摊完 */
  actualEndDay: day.nullish(),
  status: z.enum([COST_STATUS.active, COST_STATUS.ended, COST_STATUS.void]).optional(),
  category: z.string().trim().max(30).optional(),
  providerId: z.string().trim().max(40).nullish(),
  accountId: z.string().trim().max(40).nullish(),
  note: z.string().max(2000).nullish(),
});

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** GET：列出台账，附带指定周期的入账/摊销金额 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const period = resolvePeriod({
      period: sp.get("period") ?? "month",
      anchor: sp.get("anchor"),
      startDay: sp.get("startDay"),
      endDay: sp.get("endDay"),
      offset: sp.get("offset") ? Number(sp.get("offset")) : undefined,
    });

    const where: Record<string, unknown> = {};
    const providerId = sp.get("providerId");
    const accountId = sp.get("accountId");
    if (providerId) where.providerId = providerId;
    if (accountId) where.accountId = accountId;
    if (sp.get("includeVoid") !== "1") where.status = { not: COST_STATUS.void };

    const rows = await prisma.operatingCostEntry.findMany({
      where,
      orderBy: [{ startDay: "desc" }, { createdAt: "desc" }],
    });

    const summary = summarizeCosts(
      rows.map((e) => ({
        id: e.id,
        name: e.name,
        amountRmb: Number(e.amountRmb),
        mode: e.mode,
        startDay: e.startDay,
        plannedEndDay: e.plannedEndDay,
        actualEndDay: e.actualEndDay,
        status: e.status,
        category: e.category,
        providerId: e.providerId,
        accountId: e.accountId,
      })),
      period,
    );
    const allocatedById = new Map(summary.entries.map((a) => [a.id, a]));

    return NextResponse.json({
      data: {
        period,
        totalRmb: summary.totalRmb,
        earlyEndedCount: summary.earlyEndedCount,
        openEndedCount: summary.openEndedCount,
        entries: rows.map((e) => {
          const alloc = allocatedById.get(e.id);
          return {
            id: e.id,
            name: e.name,
            amountRmb: Number(e.amountRmb),
            mode: e.mode,
            startDay: e.startDay,
            plannedEndDay: e.plannedEndDay,
            actualEndDay: e.actualEndDay,
            status: e.status,
            category: e.category,
            providerId: e.providerId,
            accountId: e.accountId,
            note: e.note,
            /** 落到当前周期的金额；不在周期内为 0 */
            allocatedRmb: alloc?.allocatedRmb ?? 0,
            effectiveEndDay: alloc?.effectiveEndDay ?? e.actualEndDay ?? e.plannedEndDay,
            effectiveDays: alloc?.effectiveDays ?? null,
            earlyEnded: alloc?.earlyEnded ?? !!e.actualEndDay,
            openEnded: alloc?.openEnded ?? false,
          };
        }),
      },
    });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "查询失败");
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求体不是合法 JSON");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message || "参数无效");

  const v = parsed.data;
  const startDay = v.startDay || shanghaiDay();
  const created = await prisma.operatingCostEntry.create({
    data: {
      name: v.name,
      amountRmb: v.amountRmb,
      mode: v.mode,
      startDay,
      plannedEndDay: v.mode === COST_MODE.period ? v.plannedEndDay ?? null : null,
      actualEndDay: v.mode === COST_MODE.period ? v.actualEndDay ?? null : null,
      status: v.actualEndDay ? COST_STATUS.ended : COST_STATUS.active,
      category: v.category,
      providerId: v.providerId ?? null,
      accountId: v.accountId ?? null,
      note: v.note ?? null,
    },
  });

  return NextResponse.json({ data: { id: created.id } }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求体不是合法 JSON");
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message || "参数无效");

  const { id, ...patch } = parsed.data;
  const existing = await prisma.operatingCostEntry.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "成本记录不存在" }, { status: 404 });

  const startDay = patch.startDay ?? existing.startDay;
  const actualEndDay =
    patch.actualEndDay === undefined ? existing.actualEndDay : patch.actualEndDay;
  const plannedEndDay =
    patch.plannedEndDay === undefined ? existing.plannedEndDay : patch.plannedEndDay;

  if (actualEndDay && actualEndDay < startDay) {
    return bad("实际结束日不能早于开始日");
  }
  if (plannedEndDay && plannedEndDay < startDay) {
    return bad("计划结束日不能早于开始日");
  }

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.amountRmb !== undefined) data.amountRmb = patch.amountRmb;
  if (patch.mode !== undefined) data.mode = patch.mode;
  if (patch.startDay !== undefined) data.startDay = patch.startDay;
  if (patch.plannedEndDay !== undefined) data.plannedEndDay = patch.plannedEndDay;
  if (patch.actualEndDay !== undefined) data.actualEndDay = patch.actualEndDay;
  if (patch.category !== undefined) data.category = patch.category;
  if (patch.providerId !== undefined) data.providerId = patch.providerId;
  if (patch.accountId !== undefined) data.accountId = patch.accountId;
  if (patch.note !== undefined) data.note = patch.note;
  if (patch.status !== undefined) {
    data.status = patch.status;
  } else if (patch.actualEndDay) {
    // 填了实际结束日就视为已结束，整笔压缩到实际存活区间
    data.status = COST_STATUS.ended;
  }

  await prisma.operatingCostEntry.update({ where: { id }, data });
  return NextResponse.json({ data: { id } });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return bad("缺少 id");
  const existing = await prisma.operatingCostEntry.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "成本记录不存在" }, { status: 404 });
  await prisma.operatingCostEntry.delete({ where: { id } });
  return NextResponse.json({ data: { id } });
}
