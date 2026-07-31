import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isSelfHosted } from "@/lib/provider-kinds";
import {
  getRetirementDefaults,
  restoreProvider,
  retireProvider,
  RETIREMENT_TYPE,
} from "@/lib/provider-lifecycle";
import { runUsageRetentionForProvider } from "@/lib/usage-retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retire"),
    type: z.enum([RETIREMENT_TYPE.normal, RETIREMENT_TYPE.balanceLoss]),
    balance: z.coerce.number().min(0).optional(),
    costRate: z.coerce.number().positive().optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().trim().max(2_000).nullish(),
  }),
  z.object({ action: z.literal("restore") }),
]);

async function loadRelayProvider(id: string) {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!provider) throw new Error("上游不存在");
  if (isSelfHosted(provider.type)) throw new Error("自建上游请在自建上游页面管理");
  return provider;
}

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "状态更新失败";
  const status = message === "上游不存在" ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const provider = await loadRelayProvider(id);
    const defaults = await getRetirementDefaults(id);
    return NextResponse.json({
      data: {
        retiredAt: provider.retiredAt,
        retirementType: provider.retirementType,
        retirementNote: provider.retirementNote,
        retiredBalance: provider.retiredBalance,
        retiredCostRate: provider.retiredCostRate,
        balanceWriteOffRmb: provider.balanceWriteOffRmb,
        defaults,
      },
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await loadRelayProvider(id);
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "参数无效" },
        { status: 400 },
      );
    }

    if (parsed.data.action === "restore") {
      await restoreProvider(id);
      return NextResponse.json({ data: { restored: true } });
    }

    const retired = await retireProvider(id, parsed.data);
    let retention = null;
    let retentionError: string | null = null;
    try {
      // 弃用后不再有远端更新，立即把现存原始 JSON 压缩；大库由每日任务续跑。
      retention = await runUsageRetentionForProvider(id, {
        maxArchiveBatches: 5,
        maxDeleteBatches: 0,
      });
    } catch (error) {
      retentionError = error instanceof Error ? error.message : String(error);
    }

    return NextResponse.json({
      data: {
        retired: true,
        type: parsed.data.type,
        writeOffRmb: retired.writeOffRmb,
        balance: retired.balance,
        costRate: retired.costRate,
        day: retired.day,
        retention,
        retentionError,
      },
    });
  } catch (error) {
    return responseError(error);
  }
}
