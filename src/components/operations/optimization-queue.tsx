import { AlertTriangle, CircleHelp, Gauge, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { OptimizationAction } from "@/lib/channel-scheduler";
import { cn } from "@/lib/utils";

const iconByKind = {
  "disable-candidate": AlertTriangle,
  "raise-priority": Gauge,
  "lower-priority": TrendingDown,
  "cost-unknown": CircleHelp,
  observe: CircleHelp,
} as const;

export function OptimizationQueue({ actions, onOpen }: { actions: OptimizationAction[]; onOpen: (action: OptimizationAction) => void }) {
  const visible = actions.slice(0, 8);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">优化队列</CardTitle><p className="text-xs text-muted">按高流量故障、明显成本差、数据缺口排序；本版只给建议，不自动写入。</p></CardHeader>
      <CardContent className="space-y-2">
        {visible.length === 0 ? <p className="py-6 text-center text-sm text-muted">当前没有明确建议</p> : visible.map((item) => {
          const Icon = iconByKind[item.kind];
          return <button key={item.id} type="button" onClick={() => onOpen(item)} className="flex w-full items-start gap-3 rounded-[10px] border border-border-subtle bg-surface-2/50 p-3 text-left transition-colors hover:bg-surface-2"><span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", item.severity === "critical" ? "bg-coral/12 text-coral" : item.severity === "high" ? "bg-amber/12 text-amber" : "bg-surface-3 text-secondary")}><Icon className="h-3.5 w-3.5" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1.5"><span className="text-xs font-semibold text-text">{item.title}</span><Badge variant={item.severity === "critical" ? "coral" : item.severity === "high" ? "amber" : "default"}>#{item.channelId} · {item.channelName}</Badge></span><span className="mt-1 block text-[11px] leading-5 text-muted">{item.reason}</span></span></button>;
        })}
        {actions.length > visible.length && <p className="pt-1 text-center text-[11px] text-muted">另有 {actions.length - visible.length} 条，可在渠道矩阵中筛选查看</p>}
      </CardContent>
    </Card>
  );
}
