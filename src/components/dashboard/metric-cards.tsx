import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRmb, cn } from "@/lib/utils";
import {
  Wallet,
  TrendingDown,
  TrendingUp,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: "cyan" | "mint" | "amber" | "coral" | "violet" | "default";
}

const iconTone: Record<string, string> = {
  cyan: "text-cyan border-cyan/20 bg-cyan/5",
  mint: "text-mint border-mint/20 bg-mint/5",
  amber: "text-amber border-amber/20 bg-amber/5",
  coral: "text-coral border-coral/20 bg-coral/5",
  violet: "text-violet border-violet/20 bg-violet/5",
  default: "text-secondary border-border bg-surface-2",
};

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: MetricCardProps) {
  return (
    <Card className="relative overflow-hidden">
      <div
        className={cn(
          "pointer-events-none absolute -right-4 -top-4 h-24 w-24 rounded-full opacity-25 blur-2xl",
          tone === "cyan" && "bg-cyan",
          tone === "mint" && "bg-mint",
          tone === "amber" && "bg-amber",
          tone === "coral" && "bg-coral",
          tone === "violet" && "bg-violet",
        )}
      />
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <CardTitle>{label}</CardTitle>
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border",
            iconTone[tone],
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="font-data text-2xl font-semibold tracking-tight text-text sm:text-3xl">
          {value}
        </div>
        {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function MetricsRow({
  metrics,
}: {
  metrics: {
    totalUpstreamBalanceUsd: number;
    totalUpstreamBalanceRmb: number;
    monthCostRmb: number;
    monthRevenueRmb: number;
    monthProfitRmb: number;
    marginPct: number | null;
    costSource?: string;
    usageMonthRequests?: number;
    billableKeyCount?: number;
    hasUsageCost?: boolean;
    hasUsageRevenue?: boolean;
    operatingCostRmb?: number;
    issuedCreditRmb?: number;
    grossConsumptionRmb?: number;
    excludedRevenueRmb?: number;
  };
}) {
  const profitTone =
    metrics.monthProfitRmb > 0
      ? "mint"
      : metrics.monthProfitRmb < 0
        ? "coral"
        : "default";

  const costSourceLabel =
    metrics.costSource === "mixed"
      ? "部分站点为快照估算"
      : metrics.costSource === "snapshots"
        ? "同步快照估算，建议同步使用记录库"
        : "使用记录库";
  const costHint = metrics.hasUsageCost
    ? `中转 Key×${metrics.billableKeyCount ?? 0} · ${metrics.usageMonthRequests ?? 0} 次请求 · ${costSourceLabel}`
    : "尚未同步使用记录，回退为同步快照估算";

  const operating = metrics.operatingCostRmb ?? 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="上游总余额"
        value={formatRmb(metrics.totalUpstreamBalanceRmb)}
        hint="按各站购入成本折算的人民币"
        icon={Wallet}
        tone="cyan"
      />
      <MetricCard
        label="本月成本"
        value={formatRmb(metrics.monthCostRmb + operating)}
        hint={
          operating > 0
            ? `上游 ${formatRmb(metrics.monthCostRmb)} + 额外 ${formatRmb(operating)} · ${costSourceLabel}`
            : costHint
        }
        icon={TrendingDown}
        tone="amber"
      />
      <MetricCard
        label="本月消费收入"
        value={formatRmb(metrics.monthRevenueRmb)}
        hint={
          metrics.hasUsageRevenue
            ? (metrics.excludedRevenueRmb ?? 0) > 0
              ? `付费账号消费 · 已剔除测试号 ${formatRmb(metrics.excludedRevenueRmb)}`
              : "付费账号真实消费（充值与已发放额度不算收入）"
            : "请同步下游消费数据（充值与已发放额度都不算收入）"
        }
        icon={TrendingUp}
        tone="violet"
      />
      <MetricCard
        label="本月服务毛利"
        value={formatRmb(metrics.monthProfitRmb)}
        hint={
          metrics.marginPct != null
            ? `消费收入 − 上游成本 − 额外成本 · 毛利率 ${metrics.marginPct.toFixed(1)}%`
            : "消费收入 − 上游成本 − 额外成本"
        }
        icon={Sparkles}
        tone={profitTone}
      />
    </div>
  );
}
