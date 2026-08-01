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
      <CardHeader className="pb-2">
        <CardTitle>近 30 日 · 收入 vs 成本</CardTitle>
        <p className="text-xs text-muted">人民币 · 毛利低于零线时表示当日亏损</p>
      </CardHeader>
      <CardContent className="h-[310px] pl-2 sm:pl-5">
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
              <ReferenceLine y={0} stroke="var(--border)" />
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
              <Line
                type="monotone"
                dataKey="profitRmb"
                name="毛利"
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

export function SharePie({
  data,
}: {
  data: { id: string; name: string; consumedUsd: number; costRmb: number }[];
}) {
  const ranked = data
    .filter((d) => d.costRmb > 0 || d.consumedUsd > 0)
    .map((d) => ({
      id: d.id,
      name: d.name,
      value: d.costRmb > 0 ? d.costRmb : d.consumedUsd,
    }))
    .sort((a, b) => b.value - a.value);

  const tailValue = ranked.slice(5).reduce((sum, item) => sum + item.value, 0);
  const slices = [
    ...ranked.slice(0, 5),
    ...(tailValue > 0 ? [{ id: "other", name: "其他", value: tailValue }] : []),
  ];
  const total = slices.reduce((sum, item) => sum + item.value, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>上游成本结构</CardTitle>
        <p className="text-xs text-muted">本月供应商成本占比 · 人民币</p>
      </CardHeader>
      <CardContent className="h-[310px]">
        {slices.length === 0 ? (
          <EmptyChart hint="有增量消耗同步后显示占比" />
        ) : (
          <div className="flex h-full flex-col justify-center gap-5">
            <div>
              <p className="text-xs text-muted">本月合计</p>
              <p className="mt-1 font-data text-2xl font-semibold text-text">
                {formatRmb(total)}
              </p>
            </div>
            <div className="space-y-3.5">
              {slices.map((item, index) => {
                const percent = total > 0 ? (item.value / total) * 100 : 0;
                return (
                  <div key={item.id} className="space-y-1.5">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="min-w-0 flex-1 truncate text-secondary">
                        {item.name}
                      </span>
                      <span className="font-data text-muted">
                        {percent.toFixed(1)}%
                      </span>
                      <span className="w-20 text-right font-data text-text">
                        {formatRmb(item.value)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${percent}%`,
                          backgroundColor: SERIES[index % SERIES.length],
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyChart({ hint }: { hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="w-28 space-y-2" aria-hidden="true">
        <div className="h-1.5 w-full rounded-full bg-surface-3" />
        <div className="h-1.5 w-3/4 rounded-full bg-surface-3" />
        <div className="h-1.5 w-1/2 rounded-full bg-surface-3" />
      </div>
      <p className="max-w-[240px] text-xs leading-5 text-muted">{hint}</p>
    </div>
  );
}
