/**
 * 额外成本台账：入账与摊销
 *
 * 两种模式：
 * - ONE_TIME：整笔计入 startDay 所属周期。
 * - PERIOD  ：按天直线摊销到有效区间。
 *
 * 有效区间的终点取 actualEndDay ?? plannedEndDay。账号被风控提前结束时，
 * 填上 actualEndDay，整笔金额就压缩到「已实际存活的这几天」摊完 ——
 * 原本按月摊的钱会集中落到这几天，历史周/月报随之回算。
 *
 * 未填任何结束日的 PERIOD 视为「进行中」：以查询区间末尾为临时终点，
 * 按 30 天默认周期摊，避免一笔无限期成本把当期毛利吃穿。
 */

import {
  addDays,
  inclusiveDays,
  overlapDays,
  type ReportingPeriod,
} from "@/lib/reporting-period";

export const COST_MODE = {
  oneTime: "ONE_TIME",
  period: "PERIOD",
} as const;

export const COST_STATUS = {
  active: "active",
  ended: "ended",
  void: "void",
} as const;

/** 进行中且没有计划结束日时，按这个天数滚动摊销 */
export const OPEN_ENDED_WINDOW_DAYS = 30;

export interface CostEntryInput {
  id: string;
  name: string;
  amountRmb: number;
  mode: string;
  startDay: string;
  plannedEndDay?: string | null;
  actualEndDay?: string | null;
  status: string;
  category?: string | null;
  providerId?: string | null;
  accountId?: string | null;
  note?: string | null;
}

export interface CostAllocation {
  id: string;
  name: string;
  category: string;
  mode: string;
  amountRmb: number;
  /** 落到本周期的金额 */
  allocatedRmb: number;
  /** 实际参与摊销的区间 */
  effectiveStartDay: string;
  effectiveEndDay: string;
  effectiveDays: number;
  /** 本周期覆盖到的天数 */
  overlapDays: number;
  /** 因提前结束而压缩了摊销 */
  earlyEnded: boolean;
  /** 尚未确定结束日，按滚动窗口估算 */
  openEnded: boolean;
  providerId: string | null;
  accountId: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  // Prisma Decimal
  if (v && typeof v === "object" && "toString" in v) {
    const n = Number((v as { toString(): string }).toString());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 计算一笔成本落到指定周期的金额。不在周期内返回 null。
 */
export function allocateCostEntry(
  entry: CostEntryInput,
  period: ReportingPeriod,
): CostAllocation | null {
  if (entry.status === COST_STATUS.void) return null;

  const amount = toNumber(entry.amountRmb);
  const base = {
    id: entry.id,
    name: entry.name,
    category: entry.category || "other",
    mode: entry.mode,
    amountRmb: round2(amount),
    providerId: entry.providerId ?? null,
    accountId: entry.accountId ?? null,
  };

  if (entry.mode === COST_MODE.oneTime) {
    if (entry.startDay < period.startDay || entry.startDay > period.endDay) return null;
    return {
      ...base,
      allocatedRmb: round2(amount),
      effectiveStartDay: entry.startDay,
      effectiveEndDay: entry.startDay,
      effectiveDays: 1,
      overlapDays: 1,
      earlyEnded: false,
      openEnded: false,
    };
  }

  // PERIOD：actualEndDay 优先 —— 提前结束就把整笔压缩到实际存活区间
  const earlyEnded = !!entry.actualEndDay;
  const declaredEnd = entry.actualEndDay || entry.plannedEndDay || null;
  const openEnded = !declaredEnd;

  // 进行中且没定结束日：锚死一个滚动窗口。
  // 不能跟着查询区间走 —— 否则同一笔成本在周报和月报里每天摊的钱会不一样。
  let effectiveEndDay =
    declaredEnd ?? addDays(entry.startDay, OPEN_ENDED_WINDOW_DAYS - 1);

  if (effectiveEndDay < entry.startDay) effectiveEndDay = entry.startDay;

  const effectiveDays = inclusiveDays(entry.startDay, effectiveEndDay);
  if (effectiveDays <= 0) return null;

  const covered = overlapDays(
    entry.startDay,
    effectiveEndDay,
    period.startDay,
    period.endDay,
  );
  if (covered <= 0) return null;

  return {
    ...base,
    allocatedRmb: round2((amount * covered) / effectiveDays),
    effectiveStartDay: entry.startDay,
    effectiveEndDay,
    effectiveDays,
    overlapDays: covered,
    earlyEnded,
    openEnded,
  };
}

/** 按天摊到每一日（画趋势图用） */
export function spreadCostByDay(
  allocation: CostAllocation,
  period: ReportingPeriod,
): Map<string, number> {
  const out = new Map<string, number>();
  if (allocation.mode === COST_MODE.oneTime) {
    out.set(allocation.effectiveStartDay, allocation.allocatedRmb);
    return out;
  }
  const perDay = allocation.amountRmb / allocation.effectiveDays;
  const start =
    allocation.effectiveStartDay > period.startDay
      ? allocation.effectiveStartDay
      : period.startDay;
  const end =
    allocation.effectiveEndDay < period.endDay
      ? allocation.effectiveEndDay
      : period.endDay;
  let cursor = start;
  while (cursor <= end) {
    out.set(cursor, round2(perDay));
    cursor = addDays(cursor, 1);
  }
  return out;
}

export interface CostSummary {
  totalRmb: number;
  entries: CostAllocation[];
  byDay: Map<string, number>;
  /** 有多少笔是提前结束导致的压缩摊销 */
  earlyEndedCount: number;
  /** 有多少笔按滚动窗口估算 */
  openEndedCount: number;
}

export function summarizeCosts(
  entries: CostEntryInput[],
  period: ReportingPeriod,
): CostSummary {
  const allocations: CostAllocation[] = [];
  const byDay = new Map<string, number>();

  for (const entry of entries) {
    const alloc = allocateCostEntry(entry, period);
    if (!alloc) continue;
    allocations.push(alloc);
    for (const [day, amount] of spreadCostByDay(alloc, period)) {
      byDay.set(day, round2((byDay.get(day) || 0) + amount));
    }
  }

  allocations.sort((a, b) => b.allocatedRmb - a.allocatedRmb);

  return {
    totalRmb: round2(allocations.reduce((s, a) => s + a.allocatedRmb, 0)),
    entries: allocations,
    byDay,
    earlyEndedCount: allocations.filter((a) => a.earlyEnded).length,
    openEndedCount: allocations.filter((a) => a.openEnded).length,
  };
}
