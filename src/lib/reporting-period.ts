/**
 * 统计周期工具（统一北京时间自然周期）
 *
 * 全项目的「日」都是 Asia/Shanghai 日历日 YYYY-MM-DD，
 * 区间对外一律用**闭区间** [startDay, endDay]（和 Prisma 里 day 字段的 gte/lte 对齐），
 * 内部做天数运算时把 day 锚到 UTC 零点，避免本地时区/夏令时把边界算歪。
 *
 * 周 = 周一至周日；月 = 1 日至月末。
 */

export type PeriodKind = "week" | "month" | "custom";

export interface ReportingPeriod {
  kind: PeriodKind;
  /** 含 */
  startDay: string;
  /** 含 */
  endDay: string;
  /** 该周期共几天 */
  days: number;
  /** 人类可读标签，如「2026-07-27 ~ 2026-08-02」 */
  label: string;
}

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 任意时间戳 → Asia/Shanghai 日历日 */
export function shanghaiDay(input: Date | string | number = new Date()): string {
  const d =
    input instanceof Date
      ? input
      : typeof input === "number"
        ? new Date(input)
        : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`无法解析时间：${String(input)}`);
  }
  return shanghaiFormatter.format(d);
}

export function isDayString(v: unknown): v is string {
  return typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(dayToUtc(v));
}

export function assertDay(day: string, field = "day"): string {
  if (!isDayString(day)) {
    throw new Error(`${field} 需要 YYYY-MM-DD 格式，收到：${String(day)}`);
  }
  return day;
}

/** day → UTC 零点毫秒（仅用于天数运算，不代表真实时刻） */
function dayToUtc(day: string): number {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!m || m > 12 || !d || d > 31) return Number.NaN;
  const ts = Date.UTC(y, m - 1, d);
  // 反查一次，挡掉 2026-02-31 这种日历上不存在的日期
  const back = utcToDay(ts);
  return back === day ? ts : Number.NaN;
}

function utcToDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(day: string, delta: number): string {
  assertDay(day);
  return utcToDay(dayToUtc(day) + delta * DAY_MS);
}

/** b − a，单位天（可为负） */
export function diffDays(a: string, b: string): number {
  assertDay(a, "a");
  assertDay(b, "b");
  return Math.round((dayToUtc(b) - dayToUtc(a)) / DAY_MS);
}

/** 闭区间天数；end 早于 start 时返回 0 */
export function inclusiveDays(startDay: string, endDay: string): number {
  const n = diffDays(startDay, endDay) + 1;
  return n > 0 ? n : 0;
}

export function enumerateDays(startDay: string, endDay: string): string[] {
  const total = inclusiveDays(startDay, endDay);
  const out: string[] = [];
  for (let i = 0; i < total; i++) out.push(addDays(startDay, i));
  return out;
}

/** 闭区间是否包含某天 */
export function dayInRange(day: string, startDay: string, endDay: string): boolean {
  return day >= startDay && day <= endDay;
}

/** 两个闭区间的重叠天数 */
export function overlapDays(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return inclusiveDays(start, end);
}

/** 周一为一周之始：0 = 周一 … 6 = 周日 */
export function mondayIndex(day: string): number {
  assertDay(day);
  return (new Date(dayToUtc(day)).getUTCDay() + 6) % 7;
}

export function startOfWeekDay(day: string): string {
  return addDays(day, -mondayIndex(day));
}

export function startOfMonthDay(day: string): string {
  assertDay(day);
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonthDay(day: string): string {
  const start = startOfMonthDay(day);
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const nextMonthStart = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(nextMonthStart, -1);
}

function makePeriod(kind: PeriodKind, startDay: string, endDay: string): ReportingPeriod {
  if (endDay < startDay) {
    throw new Error(`结束日期不能早于开始日期：${startDay} ~ ${endDay}`);
  }
  return {
    kind,
    startDay,
    endDay,
    days: inclusiveDays(startDay, endDay),
    label: `${startDay} ~ ${endDay}`,
  };
}

export function weekPeriod(anchorDay: string = shanghaiDay()): ReportingPeriod {
  const start = startOfWeekDay(assertDay(anchorDay, "anchor"));
  return makePeriod("week", start, addDays(start, 6));
}

export function monthPeriod(anchorDay: string = shanghaiDay()): ReportingPeriod {
  const day = assertDay(anchorDay, "anchor");
  return makePeriod("month", startOfMonthDay(day), endOfMonthDay(day));
}

export function customPeriod(startDay: string, endDay: string): ReportingPeriod {
  return makePeriod(
    "custom",
    assertDay(startDay, "startDay"),
    assertDay(endDay, "endDay"),
  );
}

/** 上一 / 下一个周期；custom 按等长平移 */
export function shiftPeriod(period: ReportingPeriod, delta: number): ReportingPeriod {
  if (delta === 0) return period;
  if (period.kind === "week") {
    return weekPeriod(addDays(period.startDay, delta * 7));
  }
  if (period.kind === "month") {
    const anchor = addDays(period.startDay, delta > 0 ? 31 * delta : 0);
    if (delta > 0) return monthPeriod(startOfMonthDay(anchor));
    let start = period.startDay;
    for (let i = 0; i < -delta; i++) start = startOfMonthDay(addDays(start, -1));
    return monthPeriod(start);
  }
  const span = period.days;
  return customPeriod(
    addDays(period.startDay, delta * span),
    addDays(period.endDay, delta * span),
  );
}

export interface PeriodQuery {
  period?: string | null;
  /** 锚点日期，默认今天 */
  anchor?: string | null;
  startDay?: string | null;
  endDay?: string | null;
  /** 相对当前周期偏移，-1 = 上一周期 */
  offset?: number | null;
}

/**
 * 把查询参数解析成周期。
 * 显式 startDay+endDay 优先（custom），否则按 period=week|month + anchor/offset。
 */
export function resolvePeriod(query: PeriodQuery = {}): ReportingPeriod {
  const { startDay, endDay } = query;
  if (startDay && endDay) {
    return customPeriod(startDay, endDay);
  }
  const anchor = query.anchor ? assertDay(query.anchor, "anchor") : shanghaiDay();
  const kind = (query.period || "month").toLowerCase();
  const base =
    kind === "week"
      ? weekPeriod(anchor)
      : kind === "month"
        ? monthPeriod(anchor)
        : (() => {
            throw new Error(`period 只支持 week | month，收到：${kind}`);
          })();
  const offset = Number(query.offset ?? 0);
  if (!Number.isFinite(offset) || offset === 0) return base;
  return shiftPeriod(base, Math.trunc(offset));
}

/** 该周期内、且不晚于今天的天数（用于判断数据是否该有值） */
export function elapsedDays(period: ReportingPeriod, today = shanghaiDay()): number {
  if (today < period.startDay) return 0;
  const end = today < period.endDay ? today : period.endDay;
  return inclusiveDays(period.startDay, end);
}
