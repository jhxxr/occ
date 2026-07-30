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
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRmb } from "@/lib/utils";

interface DailyPoint {
  day: string;
  revenueMeasuredRmb: number;
  grossConsumptionRmb: number;
  revenueRatioRmb: number;
  upstreamCostRmb: number;
  operatingCostRmb: number;
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
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs shadow-xl">
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
    label: d.day.slice(5),
  }));
  const hasRatio = data.some((d) => d.revenueRatioRmb > 0);
  // 只有测试号真的产生了消费才画这条线，否则跟收入线重叠没意义
  const hasGross = data.some(
    (d) => d.grossConsumptionRmb - d.revenueMeasuredRmb > 0.005,
  );
  const hasAny = data.some(
    (d) =>
      d.revenueMeasuredRmb > 0 ||
      d.revenueRatioRmb > 0 ||
      d.upstreamCostRmb > 0 ||
      d.operatingCostRmb > 0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>本周期逐日走势</CardTitle>
        <p className="text-xs text-muted">
          柱：上游成本 + 额外成本 · 线：付费账号收入（虚线为对账口径与倍率估算）
        </p>
      </CardHeader>
      <CardContent className="h-[320px]">
        {!hasAny ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="h-16 w-16 rounded-full border border-dashed border-border opacity-60" />
            <p className="max-w-[260px] text-xs text-muted">
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
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }} />
              <Bar
                dataKey="upstreamCostRmb"
                name="上游成本"
                stackId="cost"
                fill="var(--series-3)"
                maxBarSize={20}
              />
              <Bar
                dataKey="operatingCostRmb"
                name="额外成本"
                stackId="cost"
                fill="var(--series-4)"
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
              {hasGross && (
                <Line
                  type="monotone"
                  dataKey="grossConsumptionRmb"
                  name="全站消费（含测试号）"
                  stroke="var(--series-5)"
                  strokeWidth={1.5}
                  strokeDasharray="2 3"
                  dot={false}
                />
              )}
              {hasRatio && (
                <Line
                  type="monotone"
                  dataKey="revenueRatioRmb"
                  name="收入·倍率估算"
                  stroke="var(--series-1)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  dot={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
