"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatRmb, cn } from "@/lib/utils";
import {
  AlertTriangle,
  RefreshCw,
  WifiOff,
  SlidersHorizontal,
  ExternalLink,
} from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { runSyncJob } from "@/lib/sync-client";
import {
  compareGroups,
  groupCategory,
  platformVariant,
  type GroupRateLike,
} from "@/lib/sub2/group-category";

export interface ProviderCardData {
  id: string;
  name: string;
  baseUrl: string;
  type: string;
  discountRate: number;
  alertThreshold: number;
  enabled: boolean;
  lastBalance: number | null;
  lastConsumed: number | null;
  lastSyncAt: string | Date | null;
  lastError: string | null;
  balanceRmb: number | null;
  isLow: boolean;
  groups: GroupRateLike[];
}

const MAX_GROUP_CHIPS = 8;

/** 去掉多余尾零：0.4 → "0.4"、1.50 → "1.5"、2.00 → "2" */
function fmtRate(v: number): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : "—";
}

/** 分类后的分组节：按类型分节、同类型低倍率在前，与「密钥/分组」详情页口径一致。 */
function categorizedGroups(groups: GroupRateLike[]) {
  const sections: { key: string; label: string; items: GroupRateLike[] }[] = [];
  const index = new Map<string, number>();
  for (const g of [...groups].sort(compareGroups)) {
    const cat = groupCategory(g);
    let i = index.get(cat.key);
    if (i == null) {
      i = sections.length;
      index.set(cat.key, i);
      sections.push({ key: cat.key, label: cat.label, items: [] });
    }
    sections[i].items.push(g);
  }
  return sections;
}

/** 紧凑的分组×倍率条：分类标签 + 胶囊，超出折叠，不让卡片越长越大。 */
function GroupRateStrip({ groups }: { groups: GroupRateLike[] }) {
  if (groups.length === 0) return null;
  const sections = categorizedGroups(groups);
  let remaining = MAX_GROUP_CHIPS;
  const shown: { key: string; label: string; items: GroupRateLike[] }[] = [];
  for (const s of sections) {
    if (remaining <= 0) break;
    const items = s.items.slice(0, remaining);
    shown.push({ ...s, items });
    remaining -= items.length;
  }
  const total = groups.length;
  const hidden = total - shown.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-2/50 px-2.5 py-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
        分组 · 倍率
      </div>
      <div className="space-y-1">
        {shown.map((s) => (
          <div key={s.key} className="flex flex-wrap items-center gap-1">
            <Badge
              variant={s.key === "image" ? "amber" : platformVariant(s.key)}
              className="px-1.5 py-0 text-[10px]"
            >
              {s.label}
            </Badge>
            {s.items.map((g) => (
              <span
                key={`${s.key}-${g.name}`}
                title={`${g.name} ×${fmtRate(g.rate_multiplier)}`}
                className="inline-flex items-center gap-1 rounded-full border border-cyan/25 bg-cyan/12 px-2 py-0.5 text-[11px] font-data tabular-nums text-cyan"
              >
                <span className="max-w-[6.5rem] truncate font-medium">
                  {g.name}
                </span>
                <span className="font-semibold">×{fmtRate(g.rate_multiplier)}</span>
              </span>
            ))}
          </div>
        ))}
        {hidden > 0 && (
          <div className="px-1 text-[11px] text-muted">+{hidden} 更多分组</div>
        )}
      </div>
    </div>
  );
}

function BalanceMeter({
  balanceRmb,
  thresholdRmb,
  isLow,
}: {
  balanceRmb: number | null;
  thresholdRmb: number;
  isLow: boolean;
}) {
  const scale = Math.max(balanceRmb ?? 0, thresholdRmb * 1.6, 1);
  const balancePct =
    balanceRmb == null ? 0 : Math.min(100, Math.max(0, (balanceRmb / scale) * 100));
  const thresholdPct = Math.min(100, Math.max(0, (thresholdRmb / scale) * 100));

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted">当前余额</p>
          <p className={cn("mt-0.5 font-data text-2xl font-semibold", isLow ? "text-coral" : "text-text")}>
            {formatRmb(balanceRmb)}
          </p>
        </div>
        <span className="text-right text-xs text-muted">
          预警线
          <span className="ml-1 font-data text-secondary">
            {formatRmb(thresholdRmb)}
          </span>
        </span>
      </div>
      <div
        className="relative h-2 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-label="余额相对预警线"
        aria-valuemin={0}
        aria-valuemax={scale}
        aria-valuenow={Math.max(0, balanceRmb ?? 0)}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-[var(--ease-spring)]",
            isLow ? "bg-coral" : "bg-accent",
          )}
          style={{ width: `${balancePct}%` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-warn"
          style={{ left: `${thresholdPct}%` }}
          title="余额预警线"
        />
      </div>
    </div>
  );
}

export function ProviderGrid({
  providers,
  onSynced,
}: {
  providers: ProviderCardData[];
  onSynced?: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});

  async function syncOne(id: string) {
    setBusyId(id);
    setError((m) => ({ ...m, [id]: "" }));
    try {
      const job = await runSyncJob({ target: "upstream", id });
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

  if (providers.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <WifiOff className="h-8 w-8 text-muted" />
          <p className="text-sm text-secondary">尚未配置中转上游</p>
          <p className="text-xs text-muted">
            前往「上游站点」添加 NewAPI / 第三方 Sub2API 账号
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {providers.map((p) => {
        const thresholdRmb = p.alertThreshold * p.discountRate;
        return (
          <Card
            key={p.id}
            className={cn(
              "transition-all duration-200 hover:shadow-lg",
              p.isLow && "border-coral/40",
              !p.enabled && "opacity-60",
            )}
          >
            <CardHeader className="pb-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-text">
                    {p.name}
                  </h3>
                  <Badge variant={p.isLow ? "coral" : "cyan"}>{p.type}</Badge>
                  {p.isLow && (
                    <Badge variant="coral" className="gap-1 normal-case">
                      <AlertTriangle className="h-3 w-3" />
                      余额预警
                    </Badge>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <BalanceMeter
                balanceRmb={p.balanceRmb}
                thresholdRmb={thresholdRmb}
                isLow={p.isLow}
              />

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted">
                    购入成本
                  </div>
                  <div className="font-data text-secondary">
                    {formatRmb(p.discountRate)}
                    <span className="text-[11px]"> / 面值单位</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted">
                    累计消耗成本
                  </div>
                  <div className="font-data text-secondary">
                    {p.lastConsumed != null
                      ? formatRmb(p.lastConsumed * p.discountRate)
                      : "—"}
                  </div>
                </div>
              </div>

              <GroupRateStrip groups={p.groups} />

              {(error[p.id] || p.lastError) && (
                <p className="rounded-[var(--r-md)] border border-coral/25 bg-coral/10 px-2.5 py-1.5 text-xs text-coral">
                  {error[p.id] || p.lastError}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
                <span className="text-xs text-muted font-data">
                  {p.lastSyncAt
                    ? `同步于 ${new Date(p.lastSyncAt).toLocaleString("zh-CN")}`
                    : "尚未同步"}
                </span>
                <div className="flex flex-wrap justify-end gap-2">
                  <a
                    href={p.baseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="打开网站"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    打开
                  </a>
                  {(p.type === "SUB2API" || p.type === "SUB2API_KEY") && (
                    <Link
                      href={`/providers/${p.id}`}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      {p.type === "SUB2API_KEY" ? "绑定密钥" : "密钥/分组"}
                    </Link>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === p.id}
                    onClick={() => syncOne(p.id)}
                  >
                    <RefreshCw
                      className={cn(
                        "h-3.5 w-3.5",
                        busyId === p.id && "animate-spin",
                      )}
                    />
                    同步
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
