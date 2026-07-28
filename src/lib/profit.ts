/**
 * Profit & cost engine
 *
 * Upstream cost (RMB) = Σ (deltaConsumedUSD × discountRate)
 *   where discountRate = actual RMB paid per $1 of upstream credit
 *
 * Downstream revenue:
 *   - if stored as CNY → use directly
 *   - if USD → multiply by usdCny rate
 *
 * Net profit = downstream revenue (RMB) − upstream cost (RMB)
 */

export interface CostPoint {
  timestamp: Date | string;
  costRmb: number;
  deltaConsumed: number;
  upstreamId?: string;
  upstreamName?: string;
}

export interface RevenuePoint {
  timestamp: Date | string;
  revenue: number;
  revenueCurrency: "USD" | "CNY" | string;
  consumed?: number;
}

export interface ProfitSummary {
  /** Upstream total cost in RMB for the window */
  totalCostRmb: number;
  /** Downstream total revenue in RMB for the window */
  totalRevenueRmb: number;
  /** Net = revenue − cost */
  netProfitRmb: number;
  /** Gross margin % (null if revenue is 0) */
  marginPct: number | null;
  /** Sum of upstream remaining balances (USD) */
  totalUpstreamBalanceUsd: number;
  /** Sum of upstream remaining balances converted via each provider's discountRate */
  totalUpstreamBalanceRmb: number;
  period: { start: Date; end: Date };
}

export interface DailySeriesPoint {
  date: string; // YYYY-MM-DD
  costRmb: number;
  revenueRmb: number;
  profitRmb: number;
}

export interface ProviderShare {
  id: string;
  name: string;
  consumedUsd: number;
  costRmb: number;
  balanceUsd: number;
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function revenueToRmb(
  amount: number,
  currency: string,
  usdCny: number,
): number {
  if (!amount) return 0;
  if (currency === "USD") return amount * usdCny;
  return amount; // assume CNY / RMB
}

/**
 * Core profit calculation over provided cost & revenue points.
 */
export function calculateProfit(opts: {
  costPoints: CostPoint[];
  revenuePoints: RevenuePoint[];
  upstreamBalances: { balanceUsd: number; discountRate: number }[];
  periodStart: Date;
  periodEnd: Date;
  usdCny?: number;
}): ProfitSummary {
  const usdCny = opts.usdCny ?? Number(process.env.DEFAULT_USD_CNY || 7.2);
  const start = opts.periodStart.getTime();
  const end = opts.periodEnd.getTime();

  const totalCostRmb = opts.costPoints
    .filter((p) => {
      const t = toDate(p.timestamp).getTime();
      return t >= start && t <= end;
    })
    .reduce((s, p) => s + (p.costRmb || 0), 0);

  const totalRevenueRmb = opts.revenuePoints
    .filter((p) => {
      const t = toDate(p.timestamp).getTime();
      return t >= start && t <= end;
    })
    .reduce(
      (s, p) => s + revenueToRmb(p.revenue || 0, p.revenueCurrency || "CNY", usdCny),
      0,
    );

  const totalUpstreamBalanceUsd = opts.upstreamBalances.reduce(
    (s, b) => s + (b.balanceUsd || 0),
    0,
  );
  const totalUpstreamBalanceRmb = opts.upstreamBalances.reduce(
    (s, b) => s + (b.balanceUsd || 0) * (b.discountRate || usdCny),
    0,
  );

  const netProfitRmb = totalRevenueRmb - totalCostRmb;
  const marginPct =
    totalRevenueRmb > 0 ? (netProfitRmb / totalRevenueRmb) * 100 : null;

  return {
    totalCostRmb,
    totalRevenueRmb,
    netProfitRmb,
    marginPct,
    totalUpstreamBalanceUsd,
    totalUpstreamBalanceRmb,
    period: { start: opts.periodStart, end: opts.periodEnd },
  };
}

/** Build last-N-days daily cost vs revenue series for charts */
export function buildDailySeries(
  costPoints: CostPoint[],
  revenuePoints: RevenuePoint[],
  days: number,
  usdCny = 7.2,
): DailySeriesPoint[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const map = new Map<string, DailySeriesPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = dayKey(d);
    map.set(key, { date: key, costRmb: 0, revenueRmb: 0, profitRmb: 0 });
  }

  for (const p of costPoints) {
    const key = dayKey(toDate(p.timestamp));
    const row = map.get(key);
    if (row) row.costRmb += p.costRmb || 0;
  }

  for (const p of revenuePoints) {
    const key = dayKey(toDate(p.timestamp));
    const row = map.get(key);
    if (row) {
      row.revenueRmb += revenueToRmb(
        p.revenue || 0,
        p.revenueCurrency || "CNY",
        usdCny,
      );
    }
  }

  for (const row of map.values()) {
    row.profitRmb = row.revenueRmb - row.costRmb;
  }

  return Array.from(map.values());
}

/** Provider consumption share for pie chart */
export function buildProviderShares(
  providers: {
    id: string;
    name: string;
    lastConsumed: number | null;
    lastBalance: number | null;
    discountRate: number;
  }[],
  recentCosts: { upstreamId: string; costRmb: number; deltaConsumed: number }[],
): ProviderShare[] {
  const costById = new Map<string, { costRmb: number; consumed: number }>();
  for (const c of recentCosts) {
    const prev = costById.get(c.upstreamId) || { costRmb: 0, consumed: 0 };
    prev.costRmb += c.costRmb;
    prev.consumed += c.deltaConsumed;
    costById.set(c.upstreamId, prev);
  }

  return providers.map((p) => {
    const c = costById.get(p.id);
    return {
      id: p.id,
      name: p.name,
      consumedUsd: c?.consumed ?? 0,
      costRmb: c?.costRmb ?? 0,
      balanceUsd: p.lastBalance ?? 0,
    };
  });
}

/** Month window helpers */
export function startOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysAgo(n: number): Date {
  const d = startOfDay();
  d.setDate(d.getDate() - n);
  return d;
}
