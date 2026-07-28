import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptSecret, maskSecret, decryptSecret } from "@/lib/crypto";
import { sub2Login } from "@/lib/adapters";

const providerSchema = z
  .object({
    name: z.string().min(1).max(100),
    baseUrl: z.string().url(),
    apiKey: z.string().optional().default(""),
    type: z.enum(["NEWAPI", "SUB2API", "ONEAPI", "OTHER"]).default("NEWAPI"),
    accountEmail: z.string().email().optional().nullable(),
    accountPassword: z.string().optional().nullable(),
    discountRate: z.number().positive().default(7.2),
    currency: z.string().default("USD"),
    alertThreshold: z.number().min(0).default(10),
    quotaPerDollar: z.number().positive().default(500000),
    enabled: z.boolean().default(true),
    notes: z.string().optional().nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.type === "SUB2API") {
      const hasJwt = !!(val.apiKey && val.apiKey.trim());
      const hasPass = !!(val.accountEmail && val.accountPassword);
      if (!hasJwt && !hasPass) {
        ctx.addIssue({
          code: "custom",
          message: "Sub2API 需提供邮箱+密码，或 JWT access_token",
          path: ["accountEmail"],
        });
      }
    } else if (!val.apiKey || !val.apiKey.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "API Key 必填",
        path: ["apiKey"],
      });
    }
  });

function publicProvider(p: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  type: string;
  accountEmail: string | null;
  accountPassword: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  discountRate: number;
  currency: string;
  alertThreshold: number;
  quotaPerDollar: number;
  enabled: boolean;
  notes: string | null;
  lastBalance: number | null;
  lastConsumed: number | null;
  lastBusinessConsumed?: number | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...p,
    apiKey: p.apiKey ? maskSecret(decryptSecret(p.apiKey)) : "",
    apiKeySet: !!p.apiKey,
    accountPassword: p.accountPassword ? "••••••••" : null,
    accountPasswordSet: !!p.accountPassword,
    refreshToken: p.refreshToken ? maskSecret(decryptSecret(p.refreshToken)) : null,
    refreshTokenSet: !!p.refreshToken,
  };
}

export async function GET() {
  const providers = await prisma.upstreamProvider.findMany({
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    data: providers.map(publicProvider),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = providerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const data = parsed.data;

    let apiKey = data.apiKey?.trim() || "";
    let refreshToken: string | null = null;
    let tokenExpiresAt: Date | null = null;

    // Sub2API: auto login with email/password to obtain JWT
    if (data.type === "SUB2API" && data.accountEmail && data.accountPassword) {
      const login = await sub2Login(
        data.baseUrl,
        data.accountEmail,
        data.accountPassword,
      );
      if (!login.ok) {
        return NextResponse.json(
          { error: `Sub2API 登录失败：${login.error}` },
          { status: 400 },
        );
      }
      apiKey = login.tokens.accessToken;
      refreshToken = login.tokens.refreshToken;
      tokenExpiresAt = login.tokens.expiresAt;
    }

    if (!apiKey && data.type !== "SUB2API") {
      return NextResponse.json({ error: "API Key 必填" }, { status: 400 });
    }

    // Sub2API balance is already USD
    const quotaPerDollar =
      data.type === "SUB2API" ? 1 : data.quotaPerDollar;

    const created = await prisma.upstreamProvider.create({
      data: {
        name: data.name,
        baseUrl: data.baseUrl,
        apiKey: apiKey ? encryptSecret(apiKey) : "",
        type: data.type,
        accountEmail: data.accountEmail ?? null,
        accountPassword: data.accountPassword
          ? encryptSecret(data.accountPassword)
          : null,
        refreshToken: refreshToken ? encryptSecret(refreshToken) : null,
        tokenExpiresAt,
        discountRate: data.discountRate,
        currency: data.currency,
        alertThreshold: data.alertThreshold,
        quotaPerDollar,
        enabled: data.enabled,
        notes: data.notes ?? null,
      },
    });
    return NextResponse.json({ data: publicProvider(created) });
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

    const existing = await prisma.upstreamProvider.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = {};
    const fields = [
      "name",
      "baseUrl",
      "type",
      "discountRate",
      "currency",
      "alertThreshold",
      "quotaPerDollar",
      "enabled",
      "notes",
      "accountEmail",
    ] as const;
    for (const f of fields) {
      if (body[f] !== undefined) updates[f] = body[f];
    }

    if (body.apiKey && typeof body.apiKey === "string" && !body.apiKey.includes("•")) {
      updates.apiKey = encryptSecret(body.apiKey);
    }
    if (
      body.accountPassword &&
      typeof body.accountPassword === "string" &&
      !body.accountPassword.includes("•")
    ) {
      updates.accountPassword = encryptSecret(body.accountPassword);
    }

    // If Sub2API password (or email) updated, re-login immediately
    const nextType = (updates.type as string) || existing.type;
    const nextEmail =
      (updates.accountEmail as string | null | undefined) !== undefined
        ? (updates.accountEmail as string | null)
        : existing.accountEmail;
    const nextPasswordPlain =
      body.accountPassword &&
      typeof body.accountPassword === "string" &&
      !body.accountPassword.includes("•")
        ? body.accountPassword
        : existing.accountPassword
          ? decryptSecret(existing.accountPassword)
          : null;
    const nextBase =
      (updates.baseUrl as string | undefined) || existing.baseUrl;
    const passwordJustSet =
      body.accountPassword &&
      typeof body.accountPassword === "string" &&
      !body.accountPassword.includes("•");
    const emailJustSet = body.accountEmail !== undefined;

    if (
      nextType === "SUB2API" &&
      nextEmail &&
      nextPasswordPlain &&
      (passwordJustSet || emailJustSet || body.relogin === true)
    ) {
      const login = await sub2Login(nextBase, nextEmail, nextPasswordPlain);
      if (!login.ok) {
        return NextResponse.json(
          { error: `Sub2API 登录失败：${login.error}` },
          { status: 400 },
        );
      }
      updates.apiKey = encryptSecret(login.tokens.accessToken);
      if (login.tokens.refreshToken) {
        updates.refreshToken = encryptSecret(login.tokens.refreshToken);
      }
      updates.tokenExpiresAt = login.tokens.expiresAt;
    }

    if (nextType === "SUB2API" && updates.quotaPerDollar === undefined) {
      // keep existing unless explicitly changed
    }

    const updated = await prisma.upstreamProvider.update({
      where: { id },
      data: updates,
    });
    return NextResponse.json({ data: publicProvider(updated) });
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
    await prisma.upstreamProvider.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  }
}
