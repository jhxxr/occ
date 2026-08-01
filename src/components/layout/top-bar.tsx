"use client";

import { RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
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
  const [message, setMessage] = useState<SyncMessage | null>(null);

  async function handleSync() {
    setSyncing(true);
    setMessage(null);

    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "all" }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "同步失败");

      const summary = json.summary;
      const hasFailures = Number(summary?.fail) > 0;
      setMessage({
        text: summary
          ? `同步完成：${summary.ok} 成功 / ${summary.fail} 失败`
          : "同步完成",
        tone: hasFailures ? "error" : "success",
      });
      onSynced?.();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "同步失败",
        tone: "error",
      });
    } finally {
      setSyncing(false);
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
              {syncing ? "同步中…" : "全量同步"}
            </Button>
          )}
        </div>
      )}
    </header>
  );
}
