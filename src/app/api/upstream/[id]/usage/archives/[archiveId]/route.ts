import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { getUsageArchiveFile } from "@/lib/usage-retention";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; archiveId: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id, archiveId } = await ctx.params;
    const { archive, filePath } = await getUsageArchiveFile(archiveId, id);
    const file = await readFile(/* turbopackIgnore: true */ filePath);
    const month = archive.firstRequestAt.toISOString().slice(0, 7);
    const name = `usage-${month}-${archive.id.slice(0, 8)}.jsonl.gz`;
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(file.byteLength),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "归档下载失败";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
