import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { listDownstreamUsersForSite } from "@/lib/downstream-fetch";
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

/** 请求体里的 id 数组 → 去重的正整数数组 */
function sanitizeIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input.map(Number).filter((n: number) => Number.isInteger(n) && n > 0),
    ),
  ];
}

/** GET — list NewAPI users with exclusion + private-domain flags */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const site = await prisma.downstreamSite.findUnique({ where: { id } });
    if (!site) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    const excludeUserIds = parseExclude(site.excludeUserIds);
    const privateUserIds = parseExclude(site.privateUserIds);
    // Bound DSN → users from MySQL; otherwise Admin HTTP.
    const result = await listDownstreamUsersForSite(site);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const included = result.users.filter((u) => !u.excluded && u.role < 100);
    const excluded = result.users.filter((u) => u.excluded || u.role >= 100);
    const revenueUsd = included.reduce((s, u) => s + u.issuedUsd, 0);
    const excludedUsd = excluded.reduce((s, u) => s + u.issuedUsd, 0);
    // 私域是付费账号的子集；公共池 = 付费 − 私域
    const privateUsers = included.filter((u) => u.isPrivate);
    const privateUsd = privateUsers.reduce((s, u) => s + u.issuedUsd, 0);

    return NextResponse.json({
      data: {
        site: {
          id: site.id,
          name: site.name,
          baseUrl: site.baseUrl,
          excludeUserIds,
          privateUserIds,
          lastRevenue: site.lastRevenue,
          lastConsumed: site.lastConsumed,
          quotaPerDollar: site.quotaPerDollar,
        },
        users: result.users,
        summary: {
          revenueUsd,
          excludedUsd,
          privateUsd,
          publicUsd: revenueUsd - privateUsd,
          includedCount: included.length,
          excludedCount: excluded.length,
          privateCount: privateUsers.length,
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
 * PUT body: { excludeUserIds: number[], privateUserIds?: number[], resync?: boolean }
 * Save exclusion / private-domain lists; optionally re-sync revenue immediately.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const site = await prisma.downstreamSite.findUnique({ where: { id } });
    if (!site) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }
    const body = await req.json();
    // 字段缺失不等于「清空排除名单」。默认 resync=true，所以一次
    // PUT {"resync":true} 会把测试号全部放回收入口径并立刻重新同步 ——
    // 收入凭空虚增，而且没有任何报错。
    if (!Array.isArray(body.excludeUserIds)) {
      return NextResponse.json(
        { error: "excludeUserIds 必须是数组（清空请显式传 []）" },
        { status: 400 },
      );
    }
    // 私域名单同理：缺失 = 不改动（老调用方只发排除名单，别把私域清空）；
    // 要清空必须显式传 []。
    if (
      body.privateUserIds !== undefined &&
      !Array.isArray(body.privateUserIds)
    ) {
      return NextResponse.json(
        { error: "privateUserIds 必须是数组（清空请显式传 []）" },
        { status: 400 },
      );
    }
    const ids = sanitizeIds(body.excludeUserIds);
    const excludeSet = new Set(ids);
    // 排除优先：同时勾了两个的算测试号，不进私域，免得两份口径打架
    const privateIds =
      body.privateUserIds === undefined
        ? null
        : sanitizeIds(body.privateUserIds).filter((n) => !excludeSet.has(n));

    await prisma.downstreamSite.update({
      where: { id },
      data: {
        excludeUserIds: JSON.stringify(ids),
        ...(privateIds ? { privateUserIds: JSON.stringify(privateIds) } : {}),
      },
    });

    let syncResult = null;
    if (body.resync !== false) {
      syncResult = await syncDownstreamSite(id);
    }

    return NextResponse.json({
      data: {
        excludeUserIds: ids,
        privateUserIds: privateIds ?? parseExclude(site.privateUserIds),
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
