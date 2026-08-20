import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createPublicApiToken,
  deletePublicApiToken,
  listPublicApiTokens,
  revokePublicApiToken,
  setPublicApiTokenEnabled,
} from "@/lib/public-api-token";

export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    name: z.string().trim().min(1, "请填写名称").max(200),
    /** 天数；不传或 null = 永不过期 */
    expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(["revoke", "enable", "disable", "delete"]),
  })
  .strict();

/** 列出 Token（不含明文） */
export async function GET() {
  try {
    const data = await listPublicApiTokens();
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "加载 Token 失败" },
      { status: 500 },
    );
  }
}

/** 新建 Token（响应含一次性明文） */
export async function POST(req: NextRequest) {
  try {
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "参数不合法" },
        { status: 400 },
      );
    }

    let expiresAt: Date | null = null;
    if (parsed.data.expiresInDays != null) {
      expiresAt = new Date(
        Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000,
      );
    }

    const data = await createPublicApiToken({
      name: parsed.data.name,
      expiresAt,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "创建 Token 失败" },
      { status: 500 },
    );
  }
}

/** 吊销 / 启停 / 删除 */
export async function PATCH(req: NextRequest) {
  try {
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "参数不合法" },
        { status: 400 },
      );
    }

    const { id, action } = parsed.data;
    if (action === "delete") {
      await deletePublicApiToken(id);
      return NextResponse.json({ data: { id, deleted: true } });
    }
    if (action === "revoke") {
      const data = await revokePublicApiToken(id);
      return NextResponse.json({ data });
    }
    if (action === "enable") {
      const data = await setPublicApiTokenEnabled(id, true);
      return NextResponse.json({ data });
    }
    const data = await setPublicApiTokenEnabled(id, false);
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "更新 Token 失败" },
      { status: 500 },
    );
  }
}
