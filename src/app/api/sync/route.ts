import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSyncJob, startSyncJob } from "@/lib/sync-runner";
import { listSyncTargets, type SyncTarget } from "@/lib/sync";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    target: z.enum(["all", "upstream", "downstream", "self-hosted"]).optional(),
    id: z.string().min(1).optional(),
  })
  .strict();

/**
 * 起一轮同步，立刻返回任务状态。
 *
 * 以前这里会一直挂着直到整轮跑完（分钟级），反代到点返回 HTML 超时页，
 * 前端 `response.json()` 就炸成 `Unexpected token '<'`。现在只返回任务 id，
 * 进度由 GET 轮询，请求本身是毫秒级的。
 */
export async function POST(req: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "参数无效" },
        { status: 400 },
      );
    }
    const { target, id } = parsed.data;

    // 单个目标：从启用列表里挑。已弃用/已停用的对象本来就同步不了
    // （runUpstreamProviderSync 会直接返回失败），这里挡掉更早、报错也更清楚。
    let targets: SyncTarget[] | undefined;
    let label: string | undefined;
    if (id && target && target !== "all") {
      const all = await listSyncTargets();
      // upstream 可能是自建站：两种 kind 都认，交给 syncTarget 按类型分派
      const hit = all.find(
        (t) =>
          t.id === id &&
          (target === "downstream"
            ? t.kind === "downstream"
            : t.kind === "upstream" || t.kind === "self-hosted"),
      );
      if (!hit) {
        return NextResponse.json(
          { error: "目标不存在、已停用或已弃用" },
          { status: 404 },
        );
      }
      targets = [hit];
      label = hit.name;
    }

    const { job, attached } = await startSyncJob({
      trigger: "manual",
      targets,
      label,
    });
    return NextResponse.json({ data: { job, attached } }, { status: 202 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 },
    );
  }
}

/** 当前 / 最近一轮同步的状态，供前端轮询 */
export async function GET() {
  try {
    return NextResponse.json({ data: { job: await getSyncJob() } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "读取同步状态失败" },
      { status: 500 },
    );
  }
}
