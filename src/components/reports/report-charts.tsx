"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRmb } from "@/lib/utils";

interface DailyPoint {
  day: string;
  revenueMeasuredRmb: number;
  grossConsumptionRmb: number;
  upstreamCostRmb: number;
  operatingCostRmb: number;
  profitMeasuredRmb: number;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-strong rounded-[var(--r-md)] px-3 py-2 text-xs">
      <div className="mb-1 font-data text-muted">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-text">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-secondary">{p.name}</span>
          <span className="ml-auto font-data">{formatRmb(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function ReportTrendChart({ data }: { data: DailyPoint[] }) {
  const chartData = data.map((d) => ({
    ...d,
    totalCostRmb: d.upstreamCostRmb + d.operatingCostRmb,
    label: d.day.slice(5),
  }));
  const hasAny = data.some(
    (d) =>
      d.revenueMeasuredRmb > 0 ||
      d.upstreamCostRmb > 0 ||
      d.operatingCostRmb > 0,
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>本周期逐日走势</CardTitle>
        <p className="text-xs text-muted">
          收入、总成本和毛利的每日变化
        </p>
      </CardHeader>
      <CardContent className="h-[320px] pl-2 sm:pl-5">
        {!hasAny ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="w-28 space-y-2" aria-hidden="true">
              <div className="h-1.5 w-full rounded-full bg-surface-3" />
              <div className="h-1.5 w-3/4 rounded-full bg-surface-3" />
              <div className="h-1.5 w-1/2 rounded-full bg-surface-3" />
            </div>
            <p className="max-w-[280px] text-xs leading-5 text-muted">
              同步下游消费与上游使用记录后，这里会显示逐日收入与成本
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "var(--muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <ReferenceLine y={0} stroke="var(--border)" />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }} />
              <Bar
                dataKey="totalCostRmb"
                name="总成本"
                fill="var(--series-3)"
                radius={[3, 3, 0, 0]}
                maxBarSize={20}
              />
              <Line
                type="monotone"
                dataKey="revenueMeasuredRmb"
                name="收入·付费账号"
                stroke="var(--series-2)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="profitMeasuredRmb"
                name="服务毛利"
                stroke="var(--series-1)"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
