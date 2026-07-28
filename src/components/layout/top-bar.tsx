"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReactNode, useState } from "react";

interface TopBarProps {
  title: string;
  subtitle?: string;
  onSynced?: () => void;
  showSync?: boolean;
  /** 额外状态行：上次同步时间、后台同步提示等 */
  statusLine?: ReactNode;
}

export function TopBar({
  title,
  subtitle,
  onSynced,
  showSync = true,
  statusLine,
}: TopBarProps) {
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function handleSync() {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "all" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "同步失败");
      const s = json.summary;
      setMsg(s ? `同步完成：${s.ok} 成功 / ${s.fail} 失败` : "同步完成");
      onSynced?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5">
      <div className="min-w-0">
        <p className="mb-1 text-[11px] uppercase tracking-[0.2em] text-muted">
          Orbit Control Center
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-text">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-secondary">{subtitle}</p>
        )}
        {statusLine && <div className="mt-1.5">{statusLine}</div>}
      </div>
      <div className="flex items-center gap-3">
        {msg && (
          <span className="text-xs text-secondary font-data max-w-[220px] truncate">
            {msg}
          </span>
        )}
        {showSync && (
          <Button onClick={handleSync} disabled={syncing} size="sm">
            <RefreshCw
              className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`}
            />
            {syncing ? "同步中…" : "全量同步"}
          </Button>
        )}
      </div>
    </header>
  );
}
