import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRmb, cn } from "@/lib/utils";
import type { CapitalPlanEstimate } from "@/lib/capital-plan";
import {
  Wallet,
  TrendingDown,
  TrendingUp,
  Sparkles,
  PiggyBank,
  Landmark,
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
  cyan: "text-cyan bg-cyan/12",
  mint: "text-mint bg-mint/12",
  amber: "text-amber bg-amber/12",
  coral: "text-coral bg-coral/12",
  violet: "text-violet bg-violet/12",
  default: "text-secondary bg-surface-3",
};

const valueTone: Record<string, string> = {
  cyan: "text-text",
  mint: "text-mint",
  amber: "text-text",
  coral: "text-coral",
  violet: "text-text",
  default: "text-text",
};

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: MetricCardProps) {
  return (
    <Card className="transition-shadow duration-200 hover:shadow-lg">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-5 pb-2">
        <CardTitle className="text-xs font-semibold text-secondary">
          {label}
        </CardTitle>
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full",
            iconTone[tone],
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="p-5 pt-1">
        <div
          className={cn(
            "font-data text-[28px] font-semibold leading-tight",
            valueTone[tone],
          )}
        >
          {value}
        </div>
        {hint && <p className="mt-2 text-xs leading-5 text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function capitalPlanHints(plan?: CapitalPlanEstimate | null): {
  investValue: string;
  investHint: string;
  investTone: MetricCardProps["tone"];
  revenueValue: string;
  revenueHint: string;
} {
  if (!plan) {
    return {
      investValue: "—",
      investHint: "同步用户余额后可估算",
      investTone: "default",
      revenueValue: "—",
      revenueHint: "预收余额消费完后的确认收入",
    };
  }
  if (!plan.balanceComplete) {
    return {
      investValue: "未同步",
      investHint: plan.reason || "请先同步下游用户余额",
      investTone: "amber",
      revenueValue: "未同步",
      revenueHint: "用户余额快照不完整，不能按 ¥0.00 解读",
    };
  }
  if (!plan.estimable) {
    const bonusNote =
      plan.bonusRemainingRmb > 0
        ? `已扣赠送 ${formatRmb(plan.bonusRemainingRmb)} · `
        : "";
    return {
      investValue: "—",
      investHint: plan.reason || "暂无法估算",
      investTone: "default",
      revenueValue: formatRmb(plan.estimatedRevenueRmb),
      revenueHint: `${bonusNote}付费余额 ${formatRmb(plan.estimatedRevenueRmb)} · ${plan.reason || "缺近期消费"}`,
    };
  }

  const rateLabel =
    plan.upstreamCostRate != null
      ? `上游成本率 ${(plan.upstreamCostRate * 100).toFixed(1)}%`
      : "按本月实测成本结构";
  const invest =
    plan.additionalUpstreamInvestRmb == null
      ? null
      : plan.additionalUpstreamInvestRmb;
  const covered = plan.covered === true;
  const bonusNote =
    plan.bonusRemainingRmb > 0
      ? `已扣赠送 ${formatRmb(plan.bonusRemainingRmb)} · `
      : "";

  return {
    investValue: invest == null ? "—" : formatRmb(invest),
    investHint: covered
      ? `上游余额已覆盖 · 所需 ${formatRmb(plan.requiredUpstreamCostRmb)} · ${rateLabel}`
      : `所需上游 ${formatRmb(plan.requiredUpstreamCostRmb)} − 已有 ${formatRmb(plan.upstreamBalanceRmb)} · ${rateLabel}`,
    investTone: covered ? "mint" : invest && invest > 0 ? "coral" : "default",
    revenueValue: formatRmb(plan.estimatedRevenueRmb),
    revenueHint:
      !plan.profitEstimable || plan.estimatedProfitRmb == null
        ? `${bonusNote}当前付费余额 · ${plan.profitReason || rateLabel}`
        : `${bonusNote}兑现后预估毛利 ${formatRmb(plan.estimatedProfitRmb)} · 预估毛利率 ${plan.marginRate == null ? "—" : `${(plan.marginRate * 100).toFixed(1)}%`}`,
  };
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
    prepaidBalanceRmb?: number;
    prepaidBalanceComplete?: boolean;
    capitalPlan?: CapitalPlanEstimate | null;
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
  const planHints = capitalPlanHints(metrics.capitalPlan);

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <MetricCard
        label="本月服务毛利"
        value={formatRmb(metrics.monthProfitRmb)}
        hint={
          metrics.marginPct != null
            ? `消费收入 - 上游成本 - 额外成本 · 毛利率 ${metrics.marginPct.toFixed(1)}%`
            : "消费收入 - 上游成本 - 额外成本"
        }
        icon={Sparkles}
        tone={profitTone}
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
        label="上游总余额"
        value={formatRmb(metrics.totalUpstreamBalanceRmb)}
        hint="按各站购入成本折算的人民币"
        icon={Wallet}
        tone="cyan"
      />
      <MetricCard
        label="还需上游投入"
        value={planHints.investValue}
        hint={planHints.investHint}
        icon={Landmark}
        tone={planHints.investTone}
      />
      <MetricCard
        label="预收预估收入"
        value={planHints.revenueValue}
        hint={planHints.revenueHint}
        icon={PiggyBank}
        tone="violet"
      />
    </div>
  );
}
