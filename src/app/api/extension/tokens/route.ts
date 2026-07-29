import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createExtensionToken } from "@/lib/crypto";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
};

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function toMetadata(
  row: {
    id: string;
    tokenPrefix: string;
    providerId: string | null;
    label: string;
    enabled: boolean;
    lastUsedAt: Date | null;
    useCount: number;
    createdAt: Date;
    updatedAt: Date;
  },
  providerName?: string | null,
) {
  return {
    id: row.id,
    tokenPrefix: row.tokenPrefix,
    providerId: row.providerId,
    providerName: providerName ?? null,
    label: row.label,
    enabled: row.enabled,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function GET() {
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
  return response({
    data: rows.map((r) =>
      toMetadata(r, r.providerId ? nameMap[r.providerId] : null),
    ),
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
      const provider = await prisma.upstreamProvider.findUnique({
        where: { id: providerId },
      });
      if (!provider) return response({ error: "上游不存在" }, 404);
    }

    const rotate = body.rotate !== false;
    if (providerId && rotate) {
      await prisma.extensionInjectToken.updateMany({
        where: { providerId, enabled: true },
        data: { enabled: false },
      });
    }

    const secret = createExtensionToken();
    const created = await prisma.extensionInjectToken.create({
      data: {
        tokenHash: secret.tokenHash,
        tokenPrefix: secret.tokenPrefix,
        providerId,
        label: label || (providerId ? "provider" : "global"),
        enabled: true,
      },
    });

    const provider = providerId
      ? await prisma.upstreamProvider.findUnique({
          where: { id: providerId },
          select: { name: true },
        })
      : null;

    return response({
      data: {
        ...toMetadata(created, provider?.name),
        token: secret.token,
        authentication: {
          endpoint: "/api/extension/inject",
          header: "X-Orbit-Token",
          alternative: "Authorization: Bearer <token>",
        },
        warning: "该 token 仅显示一次，请立即安全保存。",
      },
    });
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "Create failed" },
      500,
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return response({ error: "id required" }, 400);
    await prisma.extensionInjectToken.delete({ where: { id } }).catch(() => null);
    return response({ success: true });
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "Delete failed" },
      500,
    );
  }
}
