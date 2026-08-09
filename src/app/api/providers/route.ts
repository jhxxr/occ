import { NextRequest, NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptSecret, maskSecret, decryptSecret } from "@/lib/crypto";
import { sub2Login } from "@/lib/adapters";
import { getSub2ProxyUrl } from "@/lib/sub2/settings";
import { isSelfHosted, relayOnly } from "@/lib/provider-kinds";
import { resolveUsageArchivePath } from "@/lib/usage-retention";

/** 自建站只能在 /api/self-hosted 管，避免把 Admin Key 记录改成第三方面板 */
const SELF_HOSTED_REJECT = {
  error: "这是自建 Sub2API，请到「自建上游」页面管理",
} as const;

const providerSchema = z
  .object({
    name: z.string().min(1).max(100),
    baseUrl: z.string().url(),
    apiKey: z.string().optional().default(""),
    type: z
      .enum(["NEWAPI", "SUB2API", "MOLIFANG", "ONEAPI", "OTHER"])
      .default("NEWAPI"),
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
    } else if (val.type !== "MOLIFANG" && (!val.apiKey || !val.apiKey.trim())) {
      ctx.addIssue({
        code: "custom",
        message: "API Key 必填",
        path: ["apiKey"],
      });
    }
  });

/**
 * 更新用的部分字段校验。
 *
 * 只校验「传了的字段」，没传的不动。type 依然限定在中转类型里 ——
 * 改成 SUB2_ADMIN 会让这条记录在本页（relayOnly）和自建页（要 Admin Key）
 * 都编辑不了，等于凭空消失。
 */
const providerPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  type: z.enum(["NEWAPI", "SUB2API", "MOLIFANG", "ONEAPI", "OTHER"]).optional(),
  accountEmail: z.string().email().nullable().optional(),
  discountRate: z.number().positive().optional(),
  currency: z.string().min(1).max(10).optional(),
  alertThreshold: z.number().min(0).optional(),
  quotaPerDollar: z.number().positive().optional(),
  enabled: z.boolean().optional(),
  notes: z.string().nullable().optional(),
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
  retiredAt: Date | null;
  retirementType: string | null;
  retirementNote: string | null;
  retiredBalance: number | null;
  retiredCostRate: number | null;
  balanceWriteOffRmb: number | null;
  balanceWriteOffEntryId: string | null;
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
    where: relayOnly,
    orderBy: { createdAt: "asc" },
    include: {
      boundKeys: {
        where: { removedAt: null },
        select: { status: true, lastError: true },
      },
    },
  });
  return NextResponse.json({
    data: providers.map((provider) => {
      const providerRow = { ...provider };
      delete (providerRow as Partial<typeof provider>).boundKeys;
      const publicData = publicProvider(providerRow);
      const boundKeyCount = provider.boundKeys.length;
      const activeBoundKeyCount = provider.boundKeys.filter(
        (key) => key.status === "active",
      ).length;
      const failedBoundKeyCount = provider.boundKeys.filter(
        (key) => key.status === "active" && !!key.lastError,
      ).length;
      return {
        ...publicData,
        boundKeyCount,
        activeBoundKeyCount,
        failedBoundKeyCount,
      };
    }),
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
        await getSub2ProxyUrl(),
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

    if (!apiKey && data.type !== "SUB2API" && data.type !== "MOLIFANG") {
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
    if (isSelfHosted(existing.type)) {
      return NextResponse.json(SELF_HOSTED_REJECT, { status: 400 });
    }

    const parsed = providerPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "参数不合法", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    if (existing.retiredAt && parsed.data.enabled === true) {
      return NextResponse.json(
        { error: "已弃用上游请使用“恢复使用”，不能只打开同步开关" },
        { status: 409 },
      );
    }

    const updates: Record<string, unknown> = { ...parsed.data };

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
      const login = await sub2Login(
        nextBase,
        nextEmail,
        nextPasswordPlain,
        await getSub2ProxyUrl(),
      );
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
    const existing = await prisma.upstreamProvider.findUnique({ where: { id } });
    if (existing && isSelfHosted(existing.type)) {
      return NextResponse.json(SELF_HOSTED_REJECT, { status: 400 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!existing.retiredAt) {
      return NextResponse.json(
        { error: "请先弃用上游，再执行永久删除" },
        { status: 409 },
      );
    }
    if (searchParams.get("permanent") !== "1") {
      return NextResponse.json(
        { error: "永久删除需要明确确认" },
        { status: 400 },
      );
    }
    const archives = await prisma.upstreamUsageArchive.findMany({
      where: { providerId: id },
      select: { fileName: true },
    });
    await prisma.upstreamProvider.delete({ where: { id } });
    const archiveCleanupErrors: string[] = [];
    for (const archive of archives) {
      try {
        await unlink(
          /* turbopackIgnore: true */ resolveUsageArchivePath(archive.fileName),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          archiveCleanupErrors.push(archive.fileName);
        }
      }
    }
    return NextResponse.json({ success: true, archiveCleanupErrors });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed" },
      { status: 500 },
    );
  }
}
