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

    let local = null;
    if (typeof body.countAsCost === "boolean") {
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
          countAsCost: body.countAsCost,
        },
        update: { countAsCost: body.countAsCost },
      });
      // 日聚合重算放到后台，不阻塞勾选响应
      void recomputeCostFlags(id).catch(() => null);
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
