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
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRmb } from "@/lib/utils";

const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];

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

export function TrendChart({
  data,
}: {
  data: { date: string; costRmb: number; revenueRmb: number; profitRmb: number }[];
}) {
  const chartData = data.map((d) => ({
    ...d,
    label: d.date.slice(5), // MM-DD
  }));

  const hasData = data.some((d) => d.costRmb > 0 || d.revenueRmb > 0);

  return (
    <Card className="col-span-1 xl:col-span-2">
      <CardHeader>
        <CardTitle>近 30 日 · 收入 vs 成本</CardTitle>
        <p className="text-xs text-muted">柱：成本（RMB）· 线：收入（RMB）</p>
      </CardHeader>
      <CardContent className="h-[300px]">
        {!hasData ? (
          <EmptyChart hint="同步上游/下游后，每日成本与收入将在此累积" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
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
              <Legend
                wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }}
              />
              <Bar
                dataKey="costRmb"
                name="成本"
                fill="var(--series-3)"
                radius={[3, 3, 0, 0]}
                maxBarSize={18}
              />
              <Line
                type="monotone"
                dataKey="revenueRmb"
                name="收入"
                stroke="var(--series-2)"
                strokeWidth={2}
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

export function SharePie({
  data,
}: {
  data: { id: string; name: string; consumedUsd: number; costRmb: number }[];
}) {
  const slices = data
    .filter((d) => d.costRmb > 0 || d.consumedUsd > 0)
    .map((d) => ({
      name: d.name,
      value: d.costRmb > 0 ? d.costRmb : d.consumedUsd,
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>上游成本占比</CardTitle>
        <p className="text-xs text-muted">本月各供应商成本（RMB）</p>
      </CardHeader>
      <CardContent className="h-[300px]">
        {slices.length === 0 ? (
          <EmptyChart hint="有增量消耗同步后显示占比" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={58}
                outerRadius={92}
                paddingAngle={2}
                stroke="var(--surface)"
                strokeWidth={2}
              >
                {slices.map((_, i) => (
                  <Cell key={i} fill={SERIES[i % SERIES.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value) => formatRmb(Number(value))}
                contentStyle={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyChart({ hint }: { hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="h-16 w-16 rounded-full border border-dashed border-border opacity-60" />
      <p className="max-w-[220px] text-xs text-muted">{hint}</p>
    </div>
  );
}
