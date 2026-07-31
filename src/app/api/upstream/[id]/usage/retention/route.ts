import { NextRequest, NextResponse } from "next/server";
import {
  getUsageRetentionStatus,
  runUsageRetentionForProvider,
} from "@/lib/usage-retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : "维护失败";
  const status = message === "上游不存在" ? 404 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ data: await getUsageRetentionStatus(id) });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await runUsageRetentionForProvider(id);
    const status = await getUsageRetentionStatus(id);
    return NextResponse.json({ data: { result, status } });
  } catch (error) {
    return handleError(error);
  }
}
