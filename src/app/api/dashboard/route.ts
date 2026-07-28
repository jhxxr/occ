import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getDashboardData();
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load dashboard" },
      { status: 500 },
    );
  }
}
