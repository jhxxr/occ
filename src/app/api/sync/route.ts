import { NextRequest, NextResponse } from "next/server";
import {
  syncAll,
  syncDownstreamSite,
  syncSelfHostedProvider,
  syncUpstreamProvider,
} from "@/lib/sync";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { target, id } = body as {
      target?: "all" | "upstream" | "downstream" | "self-hosted";
      id?: string;
    };

    if (target === "self-hosted" && id) {
      const result = await syncSelfHostedProvider(id);
      return NextResponse.json({ results: [result] });
    }
    // upstream 会按 type 自动分发（自建站转走管理端同步）
    if (target === "upstream" && id) {
      const result = await syncUpstreamProvider(id);
      return NextResponse.json({ results: [result] });
    }
    if (target === "downstream" && id) {
      const result = await syncDownstreamSite(id);
      return NextResponse.json({ results: [result] });
    }

    const results = await syncAll();
    const ok = results.filter((r) => r.success).length;
    const fail = results.length - ok;
    return NextResponse.json({
      results,
      summary: { total: results.length, ok, fail },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 },
    );
  }
}
