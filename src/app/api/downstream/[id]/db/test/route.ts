import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { parseGoMysqlDsn, testNewApiDsn } from "@/lib/newapi-dsn";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/downstream/[id]/db/test
 *
 * - No body dbDsn: decrypt saved binding, test, always write dbLastTest*.
 * - Body dbDsn (paste): test that value only; never write status (save is caller's job).
 * - Masked placeholders (containing •) are ignored → falls back to saved binding.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const site = await prisma.downstreamSite.findUnique({ where: { id } });
    if (!site) {
      return NextResponse.json({ error: "站点不存在" }, { status: 404 });
    }

    let body: { dbDsn?: string } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const paste =
      typeof body.dbDsn === "string" &&
      body.dbDsn.trim() &&
      !body.dbDsn.includes("•")
        ? body.dbDsn.trim()
        : null;

    let dsnPlain: string | null = paste;
    let testingSaved = false;

    if (!dsnPlain) {
      if (!site.dbDsn) {
        return NextResponse.json(
          { error: "尚未绑定数据库，请先填写 DSN" },
          { status: 400 },
        );
      }
      dsnPlain = decryptSecret(site.dbDsn);
      if (!dsnPlain) {
        return NextResponse.json(
          {
            error:
              "已存 DSN 无法解密（ENCRYPTION_SECRET 是否更换过？请重新填写）",
          },
          { status: 400 },
        );
      }
      testingSaved = true;
    }

    try {
      parseGoMysqlDsn(dsnPlain);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "DSN 无效" },
        { status: 400 },
      );
    }

    const result = await testNewApiDsn(dsnPlain);

    if (testingSaved) {
      await prisma.downstreamSite.update({
        where: { id },
        data: {
          dbLastTestAt: new Date(),
          dbLastTestOk: result.ok,
          dbLastTestError: result.ok ? null : result.error || "连接失败",
          dbHost: result.host ?? site.dbHost,
          dbName: result.database ?? site.dbName,
        },
      });
    }

    if (!result.ok) {
      return NextResponse.json({
        success: false,
        error: result.error || "连接失败",
        data: {
          host: result.host,
          database: result.database,
          latencyMs: result.latencyMs,
          persisted: testingSaved,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        host: result.host,
        port: result.port,
        database: result.database,
        user: result.user,
        latencyMs: result.latencyMs,
        persisted: testingSaved,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "测连失败" },
      { status: 500 },
    );
  }
}
