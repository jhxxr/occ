import Link from "next/link";
import { ArrowRight, CircleDollarSign, Landmark, PiggyBank, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatRmb, cn } from "@/lib/utils";
import type { OperationsPayload } from "@/lib/operations";

export function BusinessOverview({ data }: { data: OperationsPayload }) {
  const business = data.business;
  const totalCost = business.upstreamCostRmb + business.operatingCostRmb + business.orphanCostRmb;
  const complete = data.coverage.measuredComplete && data.coverage.costComplete;
  const metrics = [
    { label: "本月消费收入", value: formatRmb(business.revenueRmb), tone: "text-violet", icon: CircleDollarSign },
    { label: "本月总成本", value: formatRmb(totalCost), tone: "text-cost", icon: Landmark },
    { label: "服务毛利", value: formatRmb(business.profitRmb), tone: business.profitRmb >= 0 ? "text-mint" : "text-coral", icon: Sparkles },
    { label: "上游可用余额", value: formatRmb(business.upstreamBalanceRmb), tone: "text-cyan", icon: PiggyBank },
  ];
  return (
    <section className="space-y-3" aria-label="经营全局">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Badge variant={complete ? "mint" : "amber"}>{complete ? "经营数据完整" : "部分数据待补齐"}</Badge>
          <Badge variant="default">成本来源 · {sourceLabel(data.coverage.costSource)}</Badge>
          <Badge variant={data.coverage.matchedChannels === data.coverage.totalChannels ? "mint" : "amber"}>成本映射 {data.coverage.matchedChannels}/{data.coverage.totalChannels}</Badge>
        </div>
        <Link href="/reports" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">查看完整对账<ArrowRight className="h-3 w-3" /></Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return <Card key={metric.label}><CardContent className="p-4"><div className="flex items-center justify-between text-xs text-muted"><span>{metric.label}</span><Icon className="h-4 w-4" /></div><div className={cn("mt-2 font-data text-2xl font-semibold", metric.tone)}>{metric.value}</div>{metric.label === "服务毛利" && <p className="mt-1 text-[11px] text-muted">毛利率 {business.marginPct == null ? "—" : `${business.marginPct.toFixed(1)}%`}</p>}</CardContent></Card>;
        })}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardContent className="p-4"><p className="text-xs font-semibold text-secondary">经营公式</p><div className="mt-2 flex flex-wrap items-center gap-2 font-data text-sm"><span className="text-violet">{formatRmb(business.revenueRmb)}</span><span className="text-muted">−</span><span className="text-cost">{formatRmb(business.upstreamCostRmb)} 上游</span><span className="text-muted">−</span><span className="text-cost">{formatRmb(business.operatingCostRmb + business.orphanCostRmb)} 额外</span><span className="text-muted">=</span><span className={business.profitRmb >= 0 ? "text-mint" : "text-coral"}>{formatRmb(business.profitRmb)}</span></div></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs font-semibold text-secondary">预收履约覆盖</p>{business.prepaidComplete ? <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><Mini label="用户余额" value={formatRmb(business.prepaidBalanceRmb)} /><Mini label="所需上游" value={formatRmb(business.requiredUpstreamCostRmb)} /><Mini label="已有上游" value={formatRmb(business.upstreamBalanceRmb)} /><Mini label="还需投入" value={formatRmb(business.additionalUpstreamInvestRmb)} danger={(business.additionalUpstreamInvestRmb ?? 0) > 0} /></div> : <p className="mt-2 text-xs text-warn">用户余额快照不完整，不能按 ¥0.00 解读。</p>}</CardContent></Card>
      </div>
    </section>
  );
}

function Mini({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) { return <div><p className="text-[10px] text-muted">{label}</p><p className={cn("mt-0.5 font-data font-semibold", danger ? "text-coral" : "text-text")}>{value}</p></div>; }
function sourceLabel(source: string) { return source === "usage-logs" ? "精确日志" : source === "mixed" ? "日志 + 快照" : source === "snapshots" ? "快照估算" : "无数据"; }
