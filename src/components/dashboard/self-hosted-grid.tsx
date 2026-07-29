"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRmb, cn } from "@/lib/utils";
import {
  RefreshCw,
  Settings2,
  ExternalLink,
  KeyRound,
} from "lucide-react";
import { useState } from "react";
import Link from "next/link";

export interface SelfHostedCardData {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  lastSyncAt: string | Date | null;
  lastError: string | null;
  lastConsumed: number | null;
  hasAdminKey: boolean;
  groupCount: number;
  accountCount: number;
  trackedGroups: number;
  trackedAccounts: number;
  monthOfficialCost: number;
  monthSellRevenueRmb: number;
  monthRequests: number;
  accountPurchaseRmb: number;
  roughProfitRmb: number;
}

export function SelfHostedGrid({
  sites,
  onSynced,
}: {
  sites: SelfHostedCardData[];
  onSynced?: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function syncOne(id: string) {
    setBusyId(id);
    try {
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "self-hosted", id }),
      });
      onSynced?.();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {sites.map((s) => (
        <Card
          key={s.id}
          className={cn(
            "transition-colors border-violet/25 bg-violet/[0.02]",
            !s.enabled && "opacity-60",
          )}
        >
          <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold text-text">
                  {s.name}
                </h3>
                <Badge variant="violet">自建管理端</Badge>
                {!s.hasAdminKey && (
                  <Badge variant="coral" className="gap-1 normal-case">
                    <KeyRound className="h-3 w-3" />
                    缺 Admin Key
                  </Badge>
                )}
              </div>
              <p className="mt-1 truncate text-xs text-muted">{s.baseUrl}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  本月官方用量
                </div>
                <div className="font-data text-lg text-text">
                  {s.monthOfficialCost.toFixed(2)}
                </div>
                <div className="text-[10px] text-muted font-data">
                  {s.monthRequests} 次请求
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  本月卖出收入
                </div>
                <div className="font-data text-lg text-mint">
                  {formatRmb(s.monthSellRevenueRmb)}
                </div>
                <div className="text-[10px] text-muted font-data">
                  {s.trackedGroups}/{s.groupCount} 分组计入
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  账号采购成本
                </div>
                <div className="font-data text-amber">
                  {formatRmb(s.accountPurchaseRmb)}
                </div>
                <div className="text-[10px] text-muted font-data">
                  {s.trackedAccounts}/{s.accountCount} 账号计入
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted">
                  粗算结余
                </div>
                <div
                  className={cn(
                    "font-data",
                    s.roughProfitRmb >= 0 ? "text-mint" : "text-coral",
                  )}
                >
                  {formatRmb(s.roughProfitRmb)}
                </div>
                <div className="text-[10px] text-muted font-data">
                  卖出 − 采购
                </div>
              </div>
            </div>

            {s.lastError && (
              <p className="rounded-md border border-coral/20 bg-coral/5 px-2 py-1.5 text-xs text-coral">
                {s.lastError}
              </p>
            )}

            {s.groupCount === 0 && !s.lastError && (
              <p className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-muted">
                还没同步到分组，点「同步」拉取管理端数据
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-muted font-data">
                {s.lastSyncAt
                  ? `同步于 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`
                  : "尚未同步"}
              </span>
              <div className="flex gap-2">
                <a
                  href={s.baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="打开面板"
                >
                  <Button size="sm" variant="outline">
                    <ExternalLink className="h-3.5 w-3.5" />
                    打开
                  </Button>
                </a>
                <Link href={`/self-hosted/${s.id}`}>
                  <Button size="sm" variant="outline">
                    <Settings2 className="h-3.5 w-3.5" />
                    分组/账号
                  </Button>
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === s.id}
                  onClick={() => syncOne(s.id)}
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      busyId === s.id && "animate-spin",
                    )}
                  />
                  同步
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
