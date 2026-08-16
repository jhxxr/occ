import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptSecret, maskSecret, decryptSecret } from "@/lib/crypto";
import { maskGoDsn, parseGoMysqlDsn } from "@/lib/newapi-dsn";

const siteSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  adminKey: z.string().min(1),
  adminUserId: z.number().int().positive().default(1),
  quotaPerDollar: z.number().positive().default(500000),
  revenueCurrency: z.enum(["CNY", "USD"]).default("CNY"),
  enabled: z.boolean().default(true),
  notes: z.string().optional().nullable(),
  /** Optional NewAPI SQL_DSN (Go format). Empty string clears on create (no-op). */
  dbDsn: z.string().optional().nullable(),
});

type DownstreamSiteRow = {
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
  dbDsn: string | null;
  dbLastTestAt: Date | null;
  dbLastTestOk: boolean | null;
  dbLastTestError: string | null;
  dbHost: string | null;
  dbName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function publicSite(s: DownstreamSiteRow) {
  let exclude: number[] = [];
  try {
    const p = JSON.parse(s.excludeUserIds || "[]");
    if (Array.isArray(p)) exclude = p.map(Number).filter((n) => Number.isFinite(n));
  } catch {
    /* ignore */
  }

  const dbBound = Boolean(s.dbDsn);
  let dbDsnMasked: string | null = null;
  if (dbBound && s.dbDsn) {
    const plain = decryptSecret(s.dbDsn);
    dbDsnMasked = plain ? maskGoDsn(plain) : "••••（已绑定）";
  }

  // Strip encrypted secrets from the spread
  const {
    adminKey: _ak,
    dbDsn: _dsn,
    ...rest
  } = s;

  return {
    ...rest,
    adminKey: maskSecret(decryptSecret(s.adminKey)),
    adminKeySet: true,
    excludeUserIds: exclude,
    excludeCount: exclude.length,
    dbBound,
    dbDsnMasked,
    dbHost: s.dbHost,
    dbName: s.dbName,
    dbLastTestAt: s.dbLastTestAt,
    dbLastTestOk: s.dbLastTestOk,
    dbLastTestError: s.dbLastTestError,
  };
}

/** Validate optional DSN paste; empty = no bind. Throws Chinese Error. */
function normalizeIncomingDsn(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("dbDsn 必须是字符串");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("•")) {
    // bullet = masked placeholder from UI; treat as "no change" if caller mishandled
    return trimmed.includes("•") ? undefined : null;
  }
  // Validate format before encrypting
  parseGoMysqlDsn(trimmed);
  return trimmed;
}

export async function GET() {
  const sites = await prisma.downstreamSite.findMany({
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ data: sites.map((s) => publicSite(s as DownstreamSiteRow)) });
}

function isClientInputError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  return (
    msg.includes("DSN") ||
    msg.includes("dbDsn") ||
    msg.includes("数据库") ||
    msg.includes("用户名") ||
    msg.includes("主机") ||
    msg.includes("端口") ||
    msg.includes("mysql://")
  );
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

    let dbDsnEnc: string | null = null;
    let dbHost: string | null = null;
    let dbName: string | null = null;
    if (data.dbDsn != null && String(data.dbDsn).trim() && !String(data.dbDsn).includes("•")) {
      const plain = normalizeIncomingDsn(data.dbDsn);
      if (plain) {
        const parts = parseGoMysqlDsn(plain);
        dbDsnEnc = encryptSecret(plain);
        dbHost = parts.host;
        dbName = parts.database;
      }
    }

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
        dbDsn: dbDsnEnc,
        dbHost,
        dbName,
      },
    });
    return NextResponse.json({ data: publicSite(created as DownstreamSiteRow) });
  } catch (e) {
    const status = isClientInputError(e) ? 400 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create failed" },
      { status },
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

    // dbDsn: omitted = no change; "" / null = unbind; non-empty = rebind
    if (Object.prototype.hasOwnProperty.call(body, "dbDsn")) {
      const plain = normalizeIncomingDsn(body.dbDsn);
      if (plain === undefined) {
        // masked placeholder — ignore
      } else if (plain === null) {
        updates.dbDsn = null;
        updates.dbHost = null;
        updates.dbName = null;
        updates.dbLastTestAt = null;
        updates.dbLastTestOk = null;
        updates.dbLastTestError = null;
      } else {
        const parts = parseGoMysqlDsn(plain);
        updates.dbDsn = encryptSecret(plain);
        updates.dbHost = parts.host;
        updates.dbName = parts.database;
        // New DSN invalidates prior test status
        updates.dbLastTestAt = null;
        updates.dbLastTestOk = null;
        updates.dbLastTestError = null;
      }
    }

    const updated = await prisma.downstreamSite.update({
      where: { id },
      data: updates,
    });
    return NextResponse.json({ data: publicSite(updated as DownstreamSiteRow) });
  } catch (e) {
    const status = isClientInputError(e) ? 400 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status },
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
