import { NextRequest, NextResponse } from "next/server";
import { parseGoMysqlDsn, testNewApiDsn } from "@/lib/newapi-dsn";

/**
 * POST /api/downstream/db/test
 * Test a pasted Go DSN without a site id (create form). Never persists.
 * Body: { dbDsn: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = typeof body.dbDsn === "string" ? body.dbDsn.trim() : "";
    if (!raw || raw.includes("•")) {
      return NextResponse.json({ error: "请填写数据库 DSN" }, { status: 400 });
    }
    try {
      parseGoMysqlDsn(raw);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "DSN 无效" },
        { status: 400 },
      );
    }
    const result = await testNewApiDsn(raw);
    if (!result.ok) {
      return NextResponse.json({
        success: false,
        error: result.error || "连接失败",
        data: {
          host: result.host,
          database: result.database,
          latencyMs: result.latencyMs,
          persisted: false,
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
        persisted: false,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "测连失败" },
      { status: 500 },
    );
  }
}
