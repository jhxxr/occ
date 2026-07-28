import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";

function makeToken(): string {
  return `oct_${randomBytes(32).toString("hex")}`;
}

function publicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "localhost:3000";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function toPublic(
  row: {
    id: string;
    token: string;
    providerId: string | null;
    label: string;
    enabled: boolean;
    lastUsedAt: Date | null;
    useCount: number;
    createdAt: Date;
    updatedAt: Date;
  },
  origin: string,
  providerName?: string | null,
) {
  const injectUrl = `${origin}/api/extension/inject?token=${encodeURIComponent(row.token)}`;
  return {
    id: row.id,
    token: row.token,
    providerId: row.providerId,
    providerName: providerName ?? null,
    label: row.label,
    enabled: row.enabled,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    /** 直接贴进扩展的完整注入链接（长期有效） */
    injectUrl,
  };
}

export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const rows = await prisma.extensionInjectToken.findMany({
    orderBy: { createdAt: "desc" },
  });
  const providerIds = [
    ...new Set(rows.map((r) => r.providerId).filter(Boolean) as string[]),
  ];
  const providers = providerIds.length
    ? await prisma.upstreamProvider.findMany({
        where: { id: { in: providerIds } },
        select: { id: true, name: true, baseUrl: true, type: true },
      })
    : [];
  const nameMap = Object.fromEntries(providers.map((p) => [p.id, p.name]));
  return NextResponse.json({
    data: rows.map((r) => toPublic(r, origin, r.providerId ? nameMap[r.providerId] : null)),
    providers: await prisma.upstreamProvider.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, baseUrl: true, type: true },
    }),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const providerId =
      typeof body.providerId === "string" && body.providerId.trim()
        ? body.providerId.trim()
        : null;
    const label =
      typeof body.label === "string" ? body.label.trim().slice(0, 100) : "";

    if (providerId) {
      const p = await prisma.upstreamProvider.findUnique({
        where: { id: providerId },
      });
      if (!p) {
        return NextResponse.json({ error: "上游不存在" }, { status: 404 });
      }
    }

    // 同一 provider 已有 token 时轮换：旧的吊销，发新的（也可 body.rotate=false 允许多条）
    const rotate = body.rotate !== false;
    if (providerId && rotate) {
      await prisma.extensionInjectToken.updateMany({
        where: { providerId, enabled: true },
        data: { enabled: false },
      });
    }

    const created = await prisma.extensionInjectToken.create({
      data: {
        token: makeToken(),
        providerId,
        label:
          label ||
          (providerId ? "provider" : "global"),
        enabled: true,
      },
    });

    let providerName: string | null = null;
    if (providerId) {
      const p = await prisma.upstreamProvider.findUnique({
        where: { id: providerId },
        select: { name: true },
      });
      providerName = p?.name ?? null;
    }

    return NextResponse.json({
      data: toPublic(created, publicOrigin(req), providerName),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const token = searchParams.get("token");
    if (!id && !token) {
      return NextResponse.json({ error: "id or token required" }, { status: 400 });
    }
    if (id) {
      await prisma.extensionInjectToken.delete({ where: { id } }).catch(() => null);
    } else if (token) {
      await prisma.extensionInjectToken
        .delete({ where: { token } })
        .catch(() => null);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  }
}
