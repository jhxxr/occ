import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptSecret, maskSecret, decryptSecret } from "@/lib/crypto";

const siteSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  adminKey: z.string().min(1),
  adminUserId: z.number().int().positive().default(1),
  quotaPerDollar: z.number().positive().default(500000),
  revenueCurrency: z.enum(["CNY", "USD"]).default("CNY"),
  enabled: z.boolean().default(true),
  notes: z.string().optional().nullable(),
});

function publicSite(s: {
  id: string;
  name: string;
  baseUrl: string;
  adminKey: string;
  adminUserId: number;
  quotaPerDollar: number;
  revenueCurrency: string;
  excludeUserIds: string;
  enabled: boolean;
  notes: string | null;
  lastConsumed: number | null;
  lastRevenue: number | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  let exclude: number[] = [];
  try {
    const p = JSON.parse(s.excludeUserIds || "[]");
    if (Array.isArray(p)) exclude = p.map(Number).filter((n) => Number.isFinite(n));
  } catch {
    /* ignore */
  }
  return {
    ...s,
    adminKey: maskSecret(decryptSecret(s.adminKey)),
    adminKeySet: true,
    excludeUserIds: exclude,
    excludeCount: exclude.length,
  };
}

export async function GET() {
  const sites = await prisma.downstreamSite.findMany({
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ data: sites.map(publicSite) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = siteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const data = parsed.data;
    const created = await prisma.downstreamSite.create({
      data: {
        name: data.name,
        baseUrl: data.baseUrl,
        adminKey: encryptSecret(data.adminKey),
        adminUserId: data.adminUserId,
        quotaPerDollar: data.quotaPerDollar,
        revenueCurrency: data.revenueCurrency,
        enabled: data.enabled,
        notes: data.notes ?? null,
      },
    });
    return NextResponse.json({ data: publicSite(created) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const id = body.id as string | undefined;
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const existing = await prisma.downstreamSite.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = {};
    for (const f of [
      "name",
      "baseUrl",
      "enabled",
      "notes",
      "adminUserId",
      "quotaPerDollar",
      "revenueCurrency",
    ] as const) {
      if (body[f] !== undefined) updates[f] = body[f];
    }
    if (
      body.adminKey &&
      typeof body.adminKey === "string" &&
      !body.adminKey.includes("•")
    ) {
      updates.adminKey = encryptSecret(body.adminKey);
    }

    const updated = await prisma.downstreamSite.update({
      where: { id },
      data: updates,
    });
    return NextResponse.json({ data: publicSite(updated) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    await prisma.downstreamSite.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  }
}
