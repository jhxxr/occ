import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Sub2Error } from "@/lib/sub2/client";
import {
  syncUsageLogs,
  queryUsageLogs,
  queryUsageStats,
} from "@/lib/sub2/sync-usage";
import { syncSub2ApiKeys } from "@/lib/sub2/sync-keys";
import { isSub2ApiKeyType } from "@/lib/provider-kinds";

type Ctx = { params: Promise<{ id: string }> };

function handleError(e: unknown) {
  if (e instanceof Sub2Error) {
    return NextResponse.json(
      { error: e.message, raw: e.raw },
      { status: e.status || 400 },
    );
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "请求失败" },
    { status: 500 },
  );
}

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * GET — 查询本地使用记录 / 统计
 *   ?view=logs|stats  (default logs)
 *   &startDate &endDate &remoteKeyId &model &page &pageSize &onlyBillable
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
    if (!provider) throw new Error("上游不存在");
    if (provider.type !== "SUB2API" && !isSub2ApiKeyType(provider.type)) {
      throw new Error("该上游不支持 Key 用量统计");
    }
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view") || "logs";
    const startDate = sp.get("startDate") || undefined;
    const endDate = sp.get("endDate") || undefined;
    const remoteKeyId = sp.get("remoteKeyId") || undefined;
    const model = sp.get("model") || undefined;
    const page = Number(sp.get("page") || 1);
    const pageSize = Number(sp.get("pageSize") || 50);
    const onlyBillable = sp.get("onlyBillable") === "1";

    if (view === "stats") {
      const stats = await queryUsageStats(id, {
        startDate,
        endDate,
        onlyBillable,
      });
      const keys = isSub2ApiKeyType(provider.type)
        ? (await prisma.upstreamBoundKey.findMany({
            where: { providerId: id, removedAt: null },
            orderBy: { name: "asc" },
          })).map((key) => ({
            remoteKeyId: key.id,
            name: key.name,
            countAsCost: key.countAsCost,
          }))
        : await prisma.upstreamApiKey.findMany({
            where: { providerId: id },
            orderBy: { name: "asc" },
          });
      return NextResponse.json({ data: { ...stats, keys } });
    }

    const logs = await queryUsageLogs(id, {
      startDate,
      endDate,
      remoteKeyId,
      model,
      page,
      pageSize,
    });
    return NextResponse.json({ data: logs });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * POST — 从远端拉取使用记录写入本地库
 * body: { startDate?, endDate?, apiKeyId?, maxPages? }
 * 不传日期则默认近 7 天
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const provider = await prisma.upstreamProvider.findUnique({ where: { id } });
    if (!provider) throw new Error("上游不存在");
    if (provider.type !== "SUB2API" && !isSub2ApiKeyType(provider.type)) {
      throw new Error("该上游不支持 Key 用量统计");
    }
    const body = await req.json().catch(() => ({}));
    const range = defaultRange();
    const startDate = (body.startDate as string) || range.startDate;
    const endDate = (body.endDate as string) || range.endDate;
    const apiKeyId =
      body.apiKeyId != null && body.apiKeyId !== ""
        ? Number(body.apiKeyId)
        : undefined;

    if (isSub2ApiKeyType(provider.type)) {
      const { syncSub2ApiKeyProvider } = await import("@/lib/sub2api-key/sync");
      const result = await syncSub2ApiKeyProvider(id);
      if (!result.success) throw new Error(result.error || "同步失败");
      const stats = await queryUsageStats(id, {
        startDate,
        endDate,
        onlyBillable: true,
      });
      return NextResponse.json({
        data: {
          sync: {
            fetched: result.succeeded,
            inserted: 0,
            updated: result.succeeded,
            daysRebuilt: 0,
          },
          billableStats: stats.summary,
        },
      });
    }

    // 先同步 key 列表，保证名称/勾选状态齐全
    await syncSub2ApiKeys(id).catch(() => null);

    const result = await syncUsageLogs(id, {
      startDate,
      endDate,
      apiKeyId: Number.isFinite(apiKeyId) ? apiKeyId : undefined,
      maxPages: body.maxPages ? Number(body.maxPages) : 50,
      pageSize: 100,
    });

    const stats = await queryUsageStats(id, {
      startDate,
      endDate,
      onlyBillable: true,
    });

    return NextResponse.json({
      data: {
        sync: result,
        billableStats: stats.summary,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
