"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
}

function OrbitRing({
  balanceRmb,
  thresholdRmb,
  isLow,
}: {
  balanceRmb: number | null;
  thresholdRmb: number;
  isLow: boolean;
}) {
  const cap = Math.max(thresholdRmb * 3, 1);
  const pct =
    balanceRmb == null ? 0 : Math.min(1, Math.max(0, balanceRmb / cap));
  const r = 28;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);
  const stroke = isLow ? "var(--coral)" : "var(--cyan)";
  const label =
    balanceRmb == null
      ? "—"
      : balanceRmb >= 1000
        ? `${(balanceRmb / 1000).toFixed(1)}k`
        : balanceRmb.toFixed(0);

  return (
    <svg width="72" height="72" viewBox="0 0 72 72" className="shrink-0">
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth="4"
      />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 36 36)"
        className="transition-all duration-700"
        style={{ filter: `drop-shadow(0 0 6px ${stroke}55)` }}
      />
      <circle
        cx="36"
        cy="36"
        r="18"
        fill="none"
        stroke="var(--border)"
        strokeWidth="1"
        strokeDasharray="2 4"
        opacity="0.5"
      />
      <text
        x="36"
        y="38"
        textAnchor="middle"
        className="font-data"
        fill="var(--text)"
        fontSize="10"
        fontWeight="600"
      >
        {label}
      </text>
    </svg>
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

  async function syncOne(id: string) {
    setBusyId(id);
    try {
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "upstream", id }),
      });
      onSynced?.();
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
              "transition-colors",
              p.isLow && "border-coral/40 bg-coral/[0.03]",
              !p.enabled && "opacity-60",
            )}
          >
            <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
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
                <p className="mt-1 truncate text-xs text-muted">{p.baseUrl}</p>
              </div>
              <OrbitRing
                balanceRmb={p.balanceRmb}
                thresholdRmb={thresholdRmb}
                isLow={p.isLow}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted">
                    余额
                  </div>
                  <div className="font-data text-lg text-text">
                    {formatRmb(p.balanceRmb)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted">
                    购入成本
                  </div>
                  <div className="font-data text-secondary">
                    {formatRmb(p.discountRate)}
                    <span className="text-[11px]"> / 面值单位</span>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted">
                    预警线
                  </div>
                  <div className="font-data text-secondary">
                    {formatRmb(thresholdRmb)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted">
                    累计消耗成本
                  </div>
                  <div className="font-data text-secondary">
                    {p.lastConsumed != null
                      ? formatRmb(p.lastConsumed * p.discountRate)
                      : "—"}
                  </div>
                </div>
              </div>

              {p.lastError && (
                <p className="rounded-md border border-coral/20 bg-coral/5 px-2 py-1.5 text-xs text-coral">
                  {p.lastError}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-[11px] text-muted font-data">
                  {p.lastSyncAt
                    ? `同步于 ${new Date(p.lastSyncAt).toLocaleString("zh-CN")}`
                    : "尚未同步"}
                </span>
                <div className="flex gap-2">
                  <a
                    href={p.baseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="打开网站"
                  >
                    <Button size="sm" variant="outline">
                      <ExternalLink className="h-3.5 w-3.5" />
                      打开
                    </Button>
                  </a>
                  {p.type === "SUB2API" && (
                    <Link href={`/providers/${p.id}`}>
                      <Button size="sm" variant="outline">
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        密钥/分组
                      </Button>
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
