import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  syncAllDownstreamModelUsage,
  syncAllDownstreamTopups,
  syncAllDownstreamUsage,
  syncDownstreamModelUsage,
  syncDownstreamTopups,
  syncDownstreamUsage,
} from "@/lib/downstream-usage";
import { prisma } from "@/lib/db";
import { syncDownstreamUserBalances } from "@/lib/downstream-recharge";
import { syncDownstreamRedemptions } from "@/lib/downstream-redemption";
import { withNewApiDbSession } from "@/lib/newapi-db";

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
    // 这一路请求会把同一个 NewAPI 库打上七八次（逐日、模型、充值、兑换码、
    // 用户列表…）。整段包进一个会话，让它们共用一条连接而不是各自握手。
    return await withNewApiDbSession(async () => {
      const results = id
        ? [await syncDownstreamUsage(id, range)]
        : await syncAllDownstreamUsage(range);
      // 同一个区间顺带同步按模型×归属用量，供报表精准拆私域/公共成本。
      // 这部分失败不影响收入事实入账，错误单独返回给界面。
      const modelResults = id
        ? [await syncDownstreamModelUsage(id, range)]
        : await syncAllDownstreamModelUsage(range);
      // 预收款是独立现金流。失败不影响消费收入和毛利同步。
      const topupResults = id
        ? [await syncDownstreamTopups(id)]
        : await syncAllDownstreamTopups();
      const balanceResults: {
        id: string;
        success: boolean;
        users?: number;
        observedAt?: Date;
        error?: string;
      }[] = [];
      const balanceSiteIds = id
        ? [id]
        : (
            await prisma.downstreamSite.findMany({
              where: { enabled: true },
              select: { id: true },
            })
          ).map((site) => site.id);
      // Balance pagination can be expensive on large NewAPI sites. Run sites
      // sequentially so one report refresh cannot stampede every downstream.
      for (const siteId of balanceSiteIds) {
        balanceResults.push(
          await syncDownstreamRedemptions(siteId)
            .then(() => syncDownstreamUserBalances(siteId))
            .then((result) => ({
              id: siteId,
              success: true,
              users: result.users.length,
              observedAt: result.observedAt,
            }))
            .catch((error) => ({
              id: siteId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            })),
        );
      }

      return NextResponse.json({
        data: {
          results,
          modelResults,
          topupResults,
          balanceResults,
          summary: {
            ok: results.filter((r) => r.success).length,
            fail: results.filter((r) => !r.success).length,
            revenueRmb:
              Math.round(
                results.reduce((s, r) => s + (r.revenueRmb || 0), 0) * 100,
              ) / 100,
            balanceOk: balanceResults.filter((result) => result.success).length,
            balanceFail: balanceResults.filter((result) => !result.success).length,
            balanceUsers: balanceResults.reduce(
              (sum, result) => sum + (result.users || 0),
              0,
            ),
          },
        },
      });
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "同步失败" },
      { status: 500 },
    );
  }
}
