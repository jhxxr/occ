"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatRmb, cn } from "@/lib/utils";
import { ExternalLink, RefreshCw, SlidersHorizontal } from "lucide-react";

export interface DownstreamCardData {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  revenueCurrency?: string;
  lastConsumed: number | null;
  /** 当前已发放额度（存量，不是收益） */
  lastRevenue: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export function DownstreamGrid({
  sites,
  usdCny,
  onSynced,
}: {
  sites: DownstreamCardData[];
  usdCny: number;
  onSynced?: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});

  /**
   * 同步这个站点：先拉余额/已发放额度快照，再补最近几天的真实消费。
   * 收入报表只认后者，所以两步都要跑。
   */
  async function syncOne(id: string) {
    setBusyId(id);
    setMsg((m) => ({ ...m, [id]: "" }));
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "downstream", id }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error || "同步失败");
      }
      const item = json?.results?.[0];
      if (item?.usageDays != null) {
        setMsg((m) => ({
          ...m,
          [id]: `已同步 ${item.usageDays} 天消费 ${formatRmb(item.usageRevenueRmb ?? 0)}`,
        }));
      } else if (item?.usageError) {
        setMsg((m) => ({ ...m, [id]: `消费数据：${item.usageError}` }));
      }
      onSynced?.();
    } catch (e) {
      setMsg((m) => ({
        ...m,
        [id]: e instanceof Error ? e.message : "同步失败",
      }));
    } finally {
      setBusyId(null);
    }
  }

  if (sites.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted">
          尚未绑定下游 NewAPI 站点 · 前往「下游站点」配置
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sites.map((s) => (
        <Card
          key={s.id}
          className={cn(
            "transition-all duration-200 hover:shadow-lg",
            !s.enabled && "border-dashed opacity-70",
          )}
        >
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-base font-semibold normal-case tracking-normal text-text">
              {s.name}
            </CardTitle>
            <Badge variant={s.enabled ? "mint" : "default"}>
              {s.enabled ? "启用" : "停用"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted">
                  最近消耗
                </div>
                <div className="font-data text-lg">{formatRmb(s.lastConsumed)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">
                  已发放额度
                </div>
                <div className="font-data text-lg">
                  {s.revenueCurrency === "USD"
                    ? formatRmb(s.lastRevenue != null ? s.lastRevenue * usdCny : null)
                    : formatRmb(s.lastRevenue)}
                </div>
                <div className="text-xs text-muted">存量，非收益</div>
              </div>
            </div>

            <div className="text-xs font-data text-muted">
              {s.lastSyncAt
                ? `同步于 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`
                : "尚未同步"}
            </div>
            {s.lastError && (
              <p className="rounded-[var(--r-md)] border border-warn/25 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                {s.lastError}
              </p>
            )}
            {msg[s.id] && (
              <p className="text-xs font-data text-mint">{msg[s.id]}</p>
            )}

            <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
              <a
                href={s.baseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                打开
              </a>
              <Link
                href={`/downstream/${s.id}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                用户/排除
              </Link>
              <Button
                size="sm"
                variant="secondary"
                disabled={busyId === s.id}
                onClick={() => syncOne(s.id)}
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", busyId === s.id && "animate-spin")}
                />
                同步
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
