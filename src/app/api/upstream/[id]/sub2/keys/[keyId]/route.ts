import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  Sub2Error,
  updateKey,
  deleteKey,
  loadSub2Provider,
} from "@/lib/sub2/client";
import { recomputeCostFlags } from "@/lib/sub2/sync-usage";

type Ctx = { params: Promise<{ id: string; keyId: string }> };

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

/** PUT — update remote key and/or local countAsCost */
export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const { id, keyId } = await ctx.params;
    await loadSub2Provider(id);
    const kid = Number(keyId);
    if (!Number.isFinite(kid)) {
      return NextResponse.json({ error: "无效 keyId" }, { status: 400 });
    }
    const body = await req.json();

    let remote = null;
    const remoteFields = [
      "name",
      "group_id",
      "status",
      "ip_whitelist",
      "ip_blacklist",
      "quota",
      "rate_limit_5h",
      "rate_limit_1d",
      "rate_limit_7d",
    ];
    const hasRemoteUpdate = remoteFields.some((f) => body[f] !== undefined);
    if (hasRemoteUpdate) {
      remote = await updateKey(id, kid, {
        name: body.name,
        group_id: body.group_id,
        status: body.status,
        ip_whitelist: body.ip_whitelist,
        ip_blacklist: body.ip_blacklist,
        quota: body.quota,
        rate_limit_5h: body.rate_limit_5h,
        rate_limit_1d: body.rate_limit_1d,
        rate_limit_7d: body.rate_limit_7d,
      });
    }

    // 本地归因：是否计入中转成本 + 绑定下游站点/分组（倍率法估算收入用）
    const localPatch: Record<string, unknown> = {};
    if (typeof body.countAsCost === "boolean") {
      localPatch.countAsCost = body.countAsCost;
    }
    if (body.downstreamSiteId !== undefined) {
      localPatch.downstreamSiteId = body.downstreamSiteId || null;
    }
    if (body.downstreamGroup !== undefined) {
      localPatch.downstreamGroup = body.downstreamGroup || null;
    }
    if (body.downstreamRate !== undefined) {
      if (body.downstreamRate === null || body.downstreamRate === "") {
        // 清空 → 回到跟随同步的分组倍率
        localPatch.downstreamRate = null;
        localPatch.downstreamRateSource = "auto";
      } else {
        const rate = Number(body.downstreamRate);
        if (!Number.isFinite(rate) || rate < 0) {
          return NextResponse.json({ error: "下游倍率无效" }, { status: 400 });
        }
        localPatch.downstreamRate = rate;
        localPatch.downstreamRateSource = "manual";
      }
    }

    let local = null;
    if (Object.keys(localPatch).length) {
      if (localPatch.downstreamSiteId) {
        const site = await prisma.downstreamSite.findUnique({
          where: { id: String(localPatch.downstreamSiteId) },
        });
        if (!site) {
          return NextResponse.json({ error: "下游站点不存在" }, { status: 400 });
        }
      }
      local = await prisma.upstreamApiKey.upsert({
        where: {
          providerId_remoteKeyId: {
            providerId: id,
            remoteKeyId: String(kid),
          },
        },
        create: {
          providerId: id,
          remoteKeyId: String(kid),
          name: body.name || remote?.name || "",
          countAsCost: localPatch.countAsCost === true,
          downstreamSiteId: (localPatch.downstreamSiteId as string) ?? null,
          downstreamGroup: (localPatch.downstreamGroup as string) ?? null,
          downstreamRate: (localPatch.downstreamRate as number) ?? null,
          downstreamRateSource:
            (localPatch.downstreamRateSource as string) ?? "auto",
        },
        update: localPatch,
      });
      if (localPatch.countAsCost !== undefined) {
        // 日聚合重算放到后台，不阻塞勾选响应
        void recomputeCostFlags(id).catch(() => null);
      }
    }

    return NextResponse.json({
      data: { remote, local, countAsCost: local?.countAsCost },
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, keyId } = await ctx.params;
    await loadSub2Provider(id);
    const kid = Number(keyId);
    if (!Number.isFinite(kid)) {
      return NextResponse.json({ error: "无效 keyId" }, { status: 400 });
    }
    await deleteKey(id, kid);
    await prisma.upstreamApiKey.deleteMany({
      where: { providerId: id, remoteKeyId: String(kid) },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return handleError(e);
  }
}
