import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { listDownstreamUsers } from "@/lib/adapters";
import { syncDownstreamSite } from "@/lib/sync";

type Ctx = { params: Promise<{ id: string }> };

function parseExclude(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) {
      return parsed.map(Number).filter((n) => Number.isFinite(n));
    }
  } catch {
    /* ignore */
  }
  return [];
}

/** GET — list NewAPI users with exclusion flags for this downstream site */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const site = await prisma.downstreamSite.findUnique({ where: { id } });
    if (!site) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    const excludeUserIds = parseExclude(site.excludeUserIds);
    const result = await listDownstreamUsers({
      baseUrl: site.baseUrl,
      adminKey: decryptSecret(site.adminKey),
      adminUserId: site.adminUserId ?? 1,
      quotaPerDollar: site.quotaPerDollar ?? 500000,
      excludeUserIds,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const included = result.users.filter((u) => !u.excluded && u.role < 100);
    const excluded = result.users.filter((u) => u.excluded || u.role >= 100);
    const revenueUsd = included.reduce((s, u) => s + u.issuedUsd, 0);
    const excludedUsd = excluded.reduce((s, u) => s + u.issuedUsd, 0);

    return NextResponse.json({
      data: {
        site: {
          id: site.id,
          name: site.name,
          baseUrl: site.baseUrl,
          excludeUserIds,
          lastRevenue: site.lastRevenue,
          lastConsumed: site.lastConsumed,
        },
        users: result.users,
        summary: {
          revenueUsd,
          excludedUsd,
          includedCount: included.length,
          excludedCount: excluded.length,
        },
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
 * PUT body: { excludeUserIds: number[], resync?: boolean }
 * Save exclusion list; optionally re-sync revenue immediately.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const site = await prisma.downstreamSite.findUnique({ where: { id } });
    if (!site) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    const body = await req.json();
    const ids = Array.isArray(body.excludeUserIds)
      ? body.excludeUserIds.map(Number).filter((n: number) => Number.isFinite(n))
      : [];

    await prisma.downstreamSite.update({
      where: { id },
      data: { excludeUserIds: JSON.stringify(ids) },
    });

    let syncResult = null;
    if (body.resync !== false) {
      syncResult = await syncDownstreamSite(id);
    }

    return NextResponse.json({
      data: {
        excludeUserIds: ids,
        sync: syncResult,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存失败" },
      { status: 500 },
    );
  }
}
