import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  syncAllDownstreamModelUsage,
  syncAllDownstreamUsage,
  syncDownstreamModelUsage,
  syncDownstreamUsage,
} from "@/lib/downstream-usage";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z
  .object({
    id: z.string().min(1).optional(),
    startDay: z.string().regex(DAY, "startDay 需要 YYYY-MM-DD").optional(),
    endDay: z.string().regex(DAY, "endDay 需要 YYYY-MM-DD").optional(),
    days: z.coerce.number().int().min(1).max(93).optional(),
  })
  .refine((v) => !!v.startDay === !!v.endDay, {
    message: "自定义区间需要同时提供 startDay 与 endDay",
  });

/** POST：拉取下游按日真实消费 + 分组倍率 */
export async function POST(req: NextRequest) {
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "参数无效" },
      { status: 400 },
    );
  }

  const { id, ...range } = parsed.data;
  try {
    const results = id
      ? [await syncDownstreamUsage(id, range)]
      : await syncAllDownstreamUsage(range);
    // 同一个区间顺带同步按模型×归属用量，供报表精准拆私域/公共成本。
    // 这部分失败不影响收入事实入账，错误单独返回给界面。
    const modelResults = id
      ? [await syncDownstreamModelUsage(id, range)]
      : await syncAllDownstreamModelUsage(range);

    return NextResponse.json({
      data: {
        results,
        modelResults,
        summary: {
          ok: results.filter((r) => r.success).length,
          fail: results.filter((r) => !r.success).length,
          revenueRmb:
            Math.round(
              results.reduce((s, r) => s + (r.revenueRmb || 0), 0) * 100,
            ) / 100,
        },
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "同步失败" },
      { status: 500 },
    );
  }
}
