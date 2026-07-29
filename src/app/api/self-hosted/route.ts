import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encryptSecret, maskSecret, decryptSecret } from "@/lib/crypto";
import { adminProbe } from "@/lib/sub2-admin/client";
import { syncSelfHostedMeta } from "@/lib/sub2-admin/sync";
import { z } from "zod";

/** GET list all self-hosted sites */
export async function GET() {
  const sites = await prisma.upstreamProvider.findMany({
    where: { type: "SUB2_ADMIN" },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    data: sites.map((s) => ({
      ...s,
      apiKey: s.apiKey ? maskSecret(decryptSecret(s.apiKey)) : "",
      apiKeySet: !!s.apiKey,
    })),
  });
}

const createSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  adminKey: z.string().min(8),
  notes: z.string().optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

/** POST create self-hosted site with admin key */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "参数无效", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { name, baseUrl, adminKey, notes, enabled } = parsed.data;

    // 先探测 key
    const probe = await adminProbe(baseUrl, adminKey);
    if (!probe.ok) {
      return NextResponse.json(
        { error: `Admin Key 无效：${probe.error}` },
        { status: 400 },
      );
    }

    const created = await prisma.upstreamProvider.create({
      data: {
        name,
        baseUrl,
        apiKey: encryptSecret(adminKey),
        type: "SUB2_ADMIN",
        // 自建站没有余额模型：不折算购入成本、不设余额预警
        discountRate: 1,
        quotaPerDollar: 1,
        alertThreshold: 0,
        enabled: enabled ?? true,
        notes: notes ?? null,
      },
    });

    // 初次同步元数据
    const meta = await syncSelfHostedMeta(created.id);

    return NextResponse.json({
      data: {
        id: created.id,
        name: created.name,
        baseUrl: created.baseUrl,
        probe,
        meta,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "创建失败" },
      { status: 500 },
    );
  }
}

/** PUT update site / admin key */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const id = body.id as string;
    if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });

    const existing = await prisma.upstreamProvider.findFirst({
      where: { id, type: "SUB2_ADMIN" },
    });
    if (!existing) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (body.name) data.name = body.name;
    if (body.baseUrl) data.baseUrl = body.baseUrl;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.adminKey && !String(body.adminKey).includes("•")) {
      const probe = await adminProbe(
        (body.baseUrl as string) || existing.baseUrl,
        body.adminKey,
      );
      if (!probe.ok) {
        return NextResponse.json(
          { error: `Admin Key 无效：${probe.error}` },
          { status: 400 },
        );
      }
      data.apiKey = encryptSecret(body.adminKey);
      // 新 Key 验证通过，旧的鉴权报错（含误建成第三方时留下的 JWT 报错）不再成立
      data.lastError = null;
    }

    const updated = await prisma.upstreamProvider.update({
      where: { id },
      data,
    });
    return NextResponse.json({
      data: {
        ...updated,
        apiKey: maskSecret(decryptSecret(updated.apiKey)),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "更新失败" },
      { status: 500 },
    );
  }
}

/** DELETE ?id= */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });
  await prisma.upstreamProvider.deleteMany({
    where: { id, type: "SUB2_ADMIN" },
  });
  return NextResponse.json({ success: true });
}
