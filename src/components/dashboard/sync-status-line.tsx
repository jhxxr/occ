"use client";

import { useEffect, useState } from "react";
import { readJson } from "@/lib/sync-client";
import type { SyncJobView } from "@/lib/sync-client";

interface AutoSyncSummary {
  config: {
    enabled: boolean;
    intervalMinutes: number;
    scope: "all" | "upstream";
    stealthRandom?: boolean;
  };
  nextRunAt: string | null;
  backoff: { key: string }[];
}

/**
 * 顶栏那一行状态：上次同步是什么时候、自动同步开没开。
 *
 * 上一轮同步被中断（容器重启）时也在这里说明，否则界面只会显示一个旧时间，
 * 看不出「其实那轮没跑完」。
 */
export function SyncStatusLine() {
  const [job, setJob] = useState<SyncJobView | null>(null);
  const [auto, setAuto] = useState<AutoSyncSummary | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [jobRes, settingsRes] = await Promise.all([
          fetch("/api/sync", { cache: "no-store" }),
          fetch("/api/settings", { cache: "no-store" }),
        ]);
        const jobPayload = await readJson(jobRes);
        const settingsPayload = await readJson(settingsRes);
        if (!alive) return;
        setJob(
          (jobPayload.data as { job?: SyncJobView | null } | undefined)?.job ?? null,
        );
        setAuto(
          (settingsPayload.data as { autoSync?: AutoSyncSummary } | undefined)
            ?.autoSync ?? null,
        );
      } catch {
        // 状态行拿不到不影响主内容，静默即可
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!job && !auto) return null;

  const parts: string[] = [];
  if (job) {
    const when = new Date(job.finishedAt || job.heartbeatAt).toLocaleString("zh-CN");
    if (job.state === "running") {
      parts.push(`同步进行中 ${job.done}/${job.total}`);
    } else if (job.state === "interrupted") {
      parts.push(`上轮同步中断（${when}）`);
    } else {
      parts.push(
        `上次同步 ${when} · ${job.ok} 成功${job.fail ? ` / ${job.fail} 失败` : ""}` +
          (job.trigger === "auto" ? "（自动）" : ""),
      );
    }
  }
  if (auto?.config.enabled) {
    parts.push(
      `自动同步 每 ${auto.config.intervalMinutes} 分钟${auto.config.scope === "upstream" ? "（仅上游）" : ""}${auto.config.stealthRandom ? " · 同态随机" : ""}`,
    );
    if (auto.backoff.length) parts.push(`${auto.backoff.length} 个目标退避中`);
  } else if (auto) {
    parts.push("自动同步未开启");
  }

  return (
    <p className="text-xs font-data text-muted">{parts.join(" · ")}</p>
  );
}
