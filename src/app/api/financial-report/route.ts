import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildFinancialReport } from "@/lib/financial-report";
import { resolvePeriod } from "@/lib/reporting-period";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    period: z.enum(["week", "month"]).optional(),
    anchor: z.string().regex(DAY, "anchor 需要 YYYY-MM-DD").optional(),
    startDay: z.string().regex(DAY, "startDay 需要 YYYY-MM-DD").optional(),
    endDay: z.string().regex(DAY, "endDay 需要 YYYY-MM-DD").optional(),
    offset: z.coerce.number().int().min(-520).max(520).optional(),
  })
  .refine((v) => !!v.startDay === !!v.endDay, {
    message: "自定义区间需要同时提供 startDay 与 endDay",
  });

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    period: sp.get("period") ?? undefined,
    anchor: sp.get("anchor") ?? undefined,
    startDay: sp.get("startDay") ?? undefined,
    endDay: sp.get("endDay") ?? undefined,
    offset: sp.get("offset") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }

  try {
    const period = resolvePeriod(parsed.data);
    const data = await buildFinancialReport(period);
    return NextResponse.json({ data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "生成报表失败";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
