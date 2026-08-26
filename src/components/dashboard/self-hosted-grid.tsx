"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatRmb, cn } from "@/lib/utils";
import {
  RefreshCw,
  Settings2,
  ExternalLink,
  KeyRound,
} from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { runSyncJob } from "@/lib/sync-client";

const MAX_GROUP_CHIPS = 8;

/** 去掉多余尾零：0.4 → "0.4"、1.50 → "1.5"、2.00 → "2" */
function fmtRate(v: number): string {
  return String(Number(v.toFixed(2)));
}

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
  groups: { name: string; sellRate: number; track: boolean }[];
  accountCount: number;
  trackedGroups: number;
  trackedAccounts: number;
  monthOfficialCost: number;
  monthSellRevenueRmb: number;
  monthRequests: number;
  accountPurchaseRmb: number;
  /** 成本台账在本月实际入账/摊销的金额 */
  operatingCostRmb: number;
}

export function SelfHostedGrid({
  sites,
  onSynced,
}: {
  sites: SelfHostedCardData[];
  onSynced?: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});

  async function syncOne(id: string) {
    setBusyId(id);
    setError((m) => ({ ...m, [id]: "" }));
    try {
      const job = await runSyncJob({ target: "self-hosted", id });
      const failed = job.results.find((r) => !r.success);
      if (failed?.error) setError((m) => ({ ...m, [id]: failed.error! }));
      onSynced?.();
    } catch (e) {
      setError((m) => ({
        ...m,
        [id]: e instanceof Error ? e.message : "同步失败",
      }));
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
            "border-violet/25 transition-all duration-200 hover:shadow-lg",
            !s.enabled && "border-dashed bg-surface-2",
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
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted">
                  本月官方用量
                </div>
                <div className="font-data text-lg text-text">
                  {s.monthOfficialCost.toFixed(2)}
                </div>
                <div className="text-xs text-muted font-data">
                  {s.monthRequests} 次请求
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">
                  卖出估算
                </div>
                <div className="font-data text-lg text-mint">
                  {formatRmb(s.monthSellRevenueRmb)}
                </div>
                <div className="text-xs text-muted font-data">
                  {s.trackedGroups}/{s.groupCount} 分组 · 仅参考
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">
                  本月成本入账
                </div>
                <div className="font-data text-amber">
                  {formatRmb(s.operatingCostRmb)}
                </div>
                <div className="text-xs text-muted font-data">
                  成本台账摊销
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">
                  账号采购登记
                </div>
                <div className="font-data text-secondary">
                  {formatRmb(s.accountPurchaseRmb)}
                </div>
                <div className="text-xs text-muted font-data">
                  {s.trackedAccounts}/{s.accountCount} 账号 · 不直接扣
                </div>
              </div>
            </div>

            {s.groups.length > 0 && (
              <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-2/50 px-2.5 py-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                  分组 · 卖出倍率
                </div>
                <div className="flex flex-wrap gap-1">
                  {s.groups.slice(0, MAX_GROUP_CHIPS).map((g) => (
                    <span
                      key={g.name}
                      title={`${g.name} ×${fmtRate(g.sellRate)}${
                        g.track ? "" : "（未追踪）"
                      }`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-data tabular-nums",
                        g.track
                          ? "border-mint/25 bg-mint/12 text-mint"
                          : "border-border-subtle bg-surface-solid text-muted",
                      )}
                    >
                      <span className="max-w-[7.5rem] truncate font-medium">
                        {g.name}
                      </span>
                      <span className="font-semibold">×{fmtRate(g.sellRate)}</span>
                    </span>
                  ))}
                  {s.groups.length > MAX_GROUP_CHIPS && (
                    <span className="inline-flex items-center px-1 text-[11px] text-muted">
                      +{s.groups.length - MAX_GROUP_CHIPS}
                    </span>
                  )}
                </div>
              </div>
            )}

            {(error[s.id] || s.lastError) && (
              <p className="rounded-[var(--r-md)] border border-coral/25 bg-coral/10 px-2.5 py-1.5 text-xs text-coral">
                {error[s.id] || s.lastError}
              </p>
            )}

            {s.groupCount === 0 && !s.lastError && !error[s.id] && (
              <p className="rounded-[var(--r-md)] border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-muted">
                还没同步到分组，点「同步」拉取管理端数据
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
              <span className="text-xs text-muted font-data">
                {s.lastSyncAt
                  ? `同步于 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`
                  : "尚未同步"}
              </span>
              <div className="flex flex-wrap justify-end gap-2">
                <a
                  href={s.baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="打开面板"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  打开
                </a>
                <Link
                  href={`/self-hosted/${s.id}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  分组/账号
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
