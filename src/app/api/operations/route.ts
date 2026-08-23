import { NextResponse } from "next/server";
import { getOperationsData } from "@/lib/operations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 统一读取经营事实、渠道健康与当前成本信号；响应不包含任何凭证或渠道 Key。 */
export async function GET() {
  try {
    const data = await getOperationsData();
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "加载运营控制台失败" },
      { status: 500 },
    );
  }
}
