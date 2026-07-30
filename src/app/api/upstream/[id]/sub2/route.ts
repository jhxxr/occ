import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  Sub2Error,
  listGroups,
  listKeys,
  createKey,
  loadSub2Provider,
  fetchKeyUsageStats,
} from "@/lib/sub2/client";
import { syncSub2ApiKeys } from "@/lib/sub2/sync-keys";

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

/** GET overview = groups + keys(merged with local countAsCost + usage) */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const provider = await loadSub2Provider(id);
    const resource = req.nextUrl.searchParams.get("resource") || "overview";

    if (resource === "groups") {
      const groups = await listGroups(id);
      return NextResponse.json({ data: { groups } });
    }

    await syncSub2ApiKeys(id).catch(() => null);

    const [groups, remoteKeys, localKeys] = await Promise.all([
      listGroups(id),
      listKeys(id),
      prisma.upstreamApiKey.findMany({ where: { providerId: id } }),
    ]);

    const localByRemote = new Map(localKeys.map((k) => [k.remoteKeyId, k]));
    const ids = remoteKeys.items.map((k) => k.id);
    const usage = await fetchKeyUsageStats(id, ids).catch(() => ({} as Record<string, never>));

    // 下游站点与已同步的分组倍率，供「这个 Key 卖到哪」的绑定用
    const [sites, groupRates] = await Promise.all([
      prisma.downstreamSite.findMany({
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, enabled: true },
      }),
      prisma.downstreamGroupRate.findMany({
        orderBy: [{ downstreamId: "asc" }, { groupName: "asc" }],
      }),
    ]);

    const keys = remoteKeys.items.map((k) => {
      const local = localByRemote.get(String(k.id));
      const stat = (
        usage as Record<
          string,
          { total_actual_cost?: number; today_actual_cost?: number }
        >
      )[String(k.id)];
      const totalActual = stat?.total_actual_cost ?? local?.totalActualCost ?? 0;
      const todayActual = stat?.today_actual_cost ?? local?.todayActualCost ?? 0;
      /** 倍率法用的下游卖出倍率：手工优先，其次跟随同步到的分组倍率 */
      const boundRate =
        local?.downstreamRate ??
        (local?.downstreamSiteId && local?.downstreamGroup
          ? groupRates.find(
              (g) =>
                g.downstreamId === local.downstreamSiteId &&
                g.groupName === local.downstreamGroup &&
                g.known,
            )?.ratio ?? null
          : null);
      return {
        ...k,
        countAsCost: local?.countAsCost ?? false,
        totalActualCost: totalActual,
        todayActualCost: todayActual,
        costRmbTotal: totalActual * (provider.discountRate || 1),
        costRmbToday: todayActual * (provider.discountRate || 1),
        downstreamSiteId: local?.downstreamSiteId ?? null,
        downstreamGroup: local?.downstreamGroup ?? null,
        downstreamRate: boundRate,
        downstreamRateSource: local?.downstreamRateSource ?? "auto",
      };
    });

    if (resource === "keys") {
      return NextResponse.json({ data: { items: keys, total: keys.length } });
    }

    const billable = keys.filter((k) => k.countAsCost);
    const billableCost = billable.reduce((s, k) => s + k.costRmbTotal, 0);

    return NextResponse.json({
      data: {
        groups,
        keys,
        total_keys: keys.length,
        billable_keys: billable.length,
        billable_cost_rmb: billableCost,
        discountRate: provider.discountRate,
        downstreamSites: sites,
        downstreamGroupRates: groupRates.map((g) => ({
          downstreamId: g.downstreamId,
          groupName: g.groupName,
          ratio: g.ratio,
          known: g.known,
        })),
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await loadSub2Provider(id);
    const body = await req.json();
    if (!body?.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name 必填" }, { status: 400 });
    }
    const created = await createKey(id, {
      name: body.name,
      group_id: body.group_id ?? null,
      custom_key: body.custom_key,
      quota: body.quota,
      expires_in_days: body.expires_in_days,
      ip_whitelist: body.ip_whitelist,
      ip_blacklist: body.ip_blacklist,
      rate_limit_5h: body.rate_limit_5h,
      rate_limit_1d: body.rate_limit_1d,
      rate_limit_7d: body.rate_limit_7d,
    });
    return NextResponse.json({ data: created });
  } catch (e) {
    return handleError(e);
  }
}
