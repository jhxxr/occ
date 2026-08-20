"use client";

import { RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  runSyncJob,
  summarizeSyncJob,
  syncProgressLabel,
  type SyncJobView,
} from "@/lib/sync-client";
import { cn } from "@/lib/utils";

interface TopBarProps {
  title: string;
  subtitle?: string;
  onSynced?: () => void;
  showSync?: boolean;
  /** 额外状态行：上次同步时间、后台同步提示等 */
  statusLine?: ReactNode;
}

interface SyncMessage {
  text: string;
  tone: "success" | "error";
}

export function TopBar({
  title,
  subtitle,
  onSynced,
  showSync = true,
  statusLine,
}: TopBarProps) {
  const [syncing, setSyncing] = useState(false);
  const [job, setJob] = useState<SyncJobView | null>(null);
  const [message, setMessage] = useState<SyncMessage | null>(null);

  async function handleSync() {
    setSyncing(true);
    setMessage(null);
    setJob(null);

    try {
      // 同步是后台任务：这里只起任务 + 轮询进度，不会让一个请求挂几分钟
      const finished = await runSyncJob({ target: "all", onProgress: setJob });
      setMessage(summarizeSyncJob(finished));
      onSynced?.();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "同步失败",
        tone: "error",
      });
    } finally {
      setSyncing(false);
      setJob(null);
    }
  }

  return (
    <header className="flex flex-col gap-4 border-b border-border-subtle pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-bold tracking-[-0.02em] text-text sm:text-[28px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 max-w-3xl break-words text-sm leading-6 text-secondary">
            {subtitle}
          </p>
        )}
        {statusLine && <div className="mt-1.5">{statusLine}</div>}
      </div>

      {(showSync || message) && (
        <div className="flex w-full min-w-0 items-center justify-end gap-3 sm:w-auto">
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "min-w-0 flex-1 break-words text-xs font-medium leading-5 sm:max-w-72 sm:flex-none",
              message?.tone === "success" && "text-mint",
              message?.tone === "error" && "text-coral",
              !message && "sr-only",
            )}
          >
            {message?.text ?? ""}
          </p>
          {showSync && (
            <Button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              size="sm"
              className="shrink-0"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", syncing && "animate-spin")}
                aria-hidden="true"
              />
              {syncing ? syncProgressLabel(job) : "全量同步"}
            </Button>
          )}
        </div>
      )}
    </header>
  );
}
