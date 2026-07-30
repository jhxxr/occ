/**
 * 渠道消费缓存 + 旧渠道成本补录
 *
 * 分两层：
 *
 * 1. **缓存层**（DownstreamChannelDaily + DownstreamScanDay）
 *    按天翻一次日志，把「哪个渠道花了多少」存下来并打上锚点。
 *    过去的日志不会再变，扫过的天下次直接跳过；只有今天每次重扫。
 *    这里记录**所有**渠道，不只是已删除的 —— 渠道是后来才被删的，
 *    只缓存当时的死渠道，等它以后被删就再也查不到历史消费了。
 *
 * 2. **补录层**（DownstreamOrphanChannel）
 *    只存你填的成本口径。消费量按周期从缓存现算，
 *    所以切周期、改倍率都不用重扫日志。
 */

import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  fetchDownstreamAliveChannels,
  fetchDownstreamChannelDay,
} from "@/lib/adapters";
import {
  assertDay,
  enumerateDays,
  inclusiveDays,
  monthPeriod,
  shanghaiDay,
  startOfMonthDay,
} from "@/lib/reporting-period";

const DEFAULT_QUOTA_PER_UNIT = 500_000;
/** 每天最多记多少个渠道摘要，防止异常数据把这一行撑爆 */
const MAX_CHANNELS_PER_DAY = 200;
/** 每个渠道最多记几个模型名（只为帮你认出是哪家上游） */
const MAX_MODELS_PER_CHANNEL = 4;

export const ORPHAN_COST_MODE = {
  /** 按购入成本率折算 */
  rate: "RATE",
  /** 填该渠道总成本，按周期消费占比分摊 */
  amount: "AMOUNT",
} as const;

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

export const GRANULARITY = {
  day: "DAY",
  month: "MONTH",
} as const;

/**
 * 渠道摘要，用紧凑键名存 JSON：
 *   c=channel id, n=渠道名, q=quota 面值, r=请求数, m=模型
 */
interface ChannelBrief {
  c: number;
  n?: string;
  q: number;
  r: number;
  m?: string;
}

/** YYYY-MM-DD → YYYY-MM */
function monthKey(day: string): string {
  return day.slice(0, 7);
}


function encodeChannels(
  rows: {
    channelId: number;
    channelName: string;
    quota: number;
    requests: number;
    models: string[];
  }[],
): string {
  const brief: ChannelBrief[] = rows
    .filter((r) => r.quota > 0 || r.requests > 0)
    .sort((a, b) => b.quota - a.quota)
    .slice(0, MAX_CHANNELS_PER_DAY)
    .map((r) => {
      const b: ChannelBrief = {
        c: r.channelId,
        // 面值小数留 6 位足够，别把浮点尾巴全存下来
        q: Math.round(r.quota * 1e6) / 1e6,
        r: r.requests,
      };
      if (r.channelName) b.n = r.channelName.slice(0, 80);
      const m = r.models.slice(0, MAX_MODELS_PER_CHANNEL).join(",");
      if (m) b.m = m.slice(0, 160);
      return b;
    });
  return JSON.stringify(brief);
}

function decodeChannels(json: string): ChannelBrief[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ChannelBrief[]) : [];
  } catch {
    return [];
  }
}

export interface ScanResult {
  id: string;
  name: string;
  success: boolean;
  /** 本次真正翻了日志的天数 */
  daysScanned: number;
  /** 命中锚点、直接跳过的天数 */
  daysSkipped: number;
  /** 翻页被截断、没记锚点的天数 */
  daysIncomplete: number;
  logsFetched: number;
  /** 因为单次上限没扫到的天数；>0 表示要再点一次继续 */
  daysDeferred: number;
  error?: string;
}

/** 单次扫描默认最多翻几天的日志（一天可能上百页请求） */
const DEFAULT_MAX_DAYS_PER_RUN = 10;

/**
 * 按天扫描渠道消费，写入缓存并打锚点。
 *
 * 已完整扫过的历史日期直接跳过；今天永远重扫（还在累积）。
 * force=true 时无视锚点全部重扫（日志被清理过、或怀疑数据不对时用）。
 */
export async function scanChannelDays(
  siteId: string,
  opts: {
    startDay: string;
    endDay: string;
    force?: boolean;
    pageSize?: number;
    maxPages?: number;
    /** 单次最多扫几天，防止一口气把对方站点打到限流 */
    maxDaysPerRun?: number;
  },
): Promise<ScanResult> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  const base: ScanResult = {
    id: siteId,
    name: site?.name ?? "?",
    success: false,
    daysScanned: 0,
    daysSkipped: 0,
    daysIncomplete: 0,
    logsFetched: 0,
    daysDeferred: 0,
  };
  if (!site) return { ...base, error: "下游站点不存在" };

  const startDay = assertDay(opts.startDay, "startDay");
  const endDay = assertDay(opts.endDay, "endDay");
  if (endDay < startDay) return { ...base, error: "结束日期不能早于开始日期" };

  const today = shanghaiDay();
  const days = enumerateDays(startDay, endDay).filter((d) => d <= today);
  if (!days.length) return { ...base, success: true };

  // 锚点两种：逐日锚点，和已压缩成月汇总的整月
  // 压缩过的月份必须也算已扫 —— 否则会重扫并和月汇总行重复计数
  const [dayAnchors, monthRows] = await Promise.all([
    prisma.downstreamChannelDay.findMany({
      where: {
        downstreamId: siteId,
        granularity: GRANULARITY.day,
        day: { in: days },
        complete: true,
      },
      select: { day: true },
    }),
    prisma.downstreamChannelDay.findMany({
      where: { downstreamId: siteId, granularity: GRANULARITY.month },
      select: { day: true },
    }),
  ]);
  const anchored = new Set(dayAnchors.map((a) => a.day));
  const compactedMonths = new Set(monthRows.map((m) => m.day));

  const input = {
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId ?? 1,
    quotaPerDollar: site.quotaPerDollar ?? DEFAULT_QUOTA_PER_UNIT,
  };

  let daysScanned = 0;
  let daysSkipped = 0;
  let daysIncomplete = 0;
  let logsFetched = 0;
  let lastError: string | undefined;

  // force 重扫压缩过的月份：先删掉月汇总，否则新写的日行会和它重复计数
  if (opts.force) {
    const touched = [...new Set(days.map(monthKey))].filter((m) =>
      compactedMonths.has(m),
    );
    if (touched.length) {
      await prisma.downstreamChannelDay.deleteMany({
        where: {
          downstreamId: siteId,
          granularity: GRANULARITY.month,
          day: { in: touched },
        },
      });
      for (const m of touched) compactedMonths.delete(m);
    }
  }

  // 单次扫描上限：一天可能上百页请求，一口气扫整月会把对方站点打到限流
  const maxDays = Math.max(1, opts.maxDaysPerRun ?? DEFAULT_MAX_DAYS_PER_RUN);
  let daysDeferred = 0;

  // 从近到远扫：最近的数据最有用，被上限截断时留下的是更老的天
  const ordered = [...days].reverse();

  for (const day of ordered) {
    // 今天还在累积，锚点不作数
    if (!opts.force && anchored.has(day) && day < today) {
      daysSkipped++;
      continue;
    }
    // 该月已压缩成汇总行：这一天的明细已经并进去了，重扫会重复计数
    if (!opts.force && compactedMonths.has(monthKey(day))) {
      daysSkipped++;
      continue;
    }
    // 到量就停，剩下的下次再扫（锚点保证不会重复劳动）
    if (daysScanned >= maxDays) {
      daysDeferred++;
      continue;
    }

    const res = await fetchDownstreamChannelDay({
      ...input,
      day,
      pageSize: opts.pageSize,
      maxPages: opts.maxPages,
    });
    if (!res.success) {
      lastError = res.error;
      continue;
    }

    logsFetched += res.scanned;
    daysScanned++;
    if (!res.complete) daysIncomplete++;

    // 一天一行、整行覆盖：不会有上次截断留下的残值
    const payload = {
      channels: encodeChannels(res.channels),
      logCount: res.scanned,
      totalQuota: res.channels.reduce((s, c) => s + c.quota, 0),
      // 今天先不落锚点，明天还会变
      complete: res.complete && day < today,
      scannedAt: new Date(),
    };
    await prisma.downstreamChannelDay.upsert({
      where: { downstreamId_day: { downstreamId: siteId, day } },
      create: {
        downstreamId: siteId,
        day,
        granularity: GRANULARITY.day,
        spanDays: 1,
        ...payload,
      },
      update: payload,
    });
  }

  return {
    id: siteId,
    name: site.name,
    success: true,
    daysScanned,
    daysSkipped,
    daysIncomplete,
    logsFetched,
    daysDeferred,
    error: lastError,
  };
}

export interface CompactResult {
  id: string;
  name: string;
  /** 压缩了几个月 */
  months: number;
  /** 合并掉的日行数 */
  daysCompacted: number;
  /** 压缩前后的字节数 */
  bytesBefore: number;
  bytesAfter: number;
  /** 被压缩的月份 */
  monthKeys: string[];
}

/**
 * 压缩老数据：把上上个月及更早的逐日行合并成一个月一行。
 *
 * 保留近两个自然月的逐日精度（当月 + 上月），够看周报和最近的对账；
 * 更早的只留 id / 面值 / 请求数，丢掉渠道名和模型 ——
 * 那两样是给你「认出这是哪家上游」用的，成本填完就没价值了。
 *
 * 压缩是幂等的：已经是 MONTH 的行不会再动。
 * 压缩后该月不能再算周报（只有月度总量），报表会标成估算。
 */
export async function compactChannelCache(
  siteId: string,
  opts: { keepMonths?: number; before?: string } = {},
): Promise<CompactResult> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  const out: CompactResult = {
    id: siteId,
    name: site?.name ?? "?",
    months: 0,
    daysCompacted: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    monthKeys: [],
  };
  if (!site) return out;

  // 默认保留当月 + 上月的逐日精度：cutoff = 往前退 (keep-1) 个月的 1 号
  const keep = Math.max(1, opts.keepMonths ?? 2);
  const anchorMonth = startOfMonthDay(opts.before ?? shanghaiDay());
  const cut = new Date(`${anchorMonth}T00:00:00Z`);
  cut.setUTCMonth(cut.getUTCMonth() - (keep - 1));
  const cutoffMonthStart = cut.toISOString().slice(0, 10);

  // 早于 cutoff 的逐日行才压缩
  const rows = await prisma.downstreamChannelDay.findMany({
    where: {
      downstreamId: siteId,
      granularity: GRANULARITY.day,
      day: { lt: cutoffMonthStart },
    },
    orderBy: { day: "asc" },
  });
  if (!rows.length) return out;

  const byMonth = new Map<
    string,
    {
      days: string[];
      logCount: number;
      totalQuota: number;
      complete: boolean;
      channels: Map<number, { q: number; r: number }>;
      bytes: number;
    }
  >();

  for (const r of rows) {
    const mk = monthKey(r.day);
    const cur =
      byMonth.get(mk) ||
      {
        days: [],
        logCount: 0,
        totalQuota: 0,
        complete: true,
        channels: new Map<number, { q: number; r: number }>(),
        bytes: 0,
      };
    cur.days.push(r.day);
    cur.logCount += r.logCount;
    cur.totalQuota += r.totalQuota;
    if (!r.complete) cur.complete = false;
    cur.bytes += r.channels.length;
    for (const c of decodeChannels(r.channels)) {
      const agg = cur.channels.get(c.c) || { q: 0, r: 0 };
      agg.q += c.q || 0;
      agg.r += c.r || 0;
      cur.channels.set(c.c, agg);
    }
    byMonth.set(mk, cur);
  }

  for (const [mk, m] of byMonth) {
    // 月汇总只留 id / 面值 / 请求数
    const brief = [...m.channels.entries()]
      .map(([c, v]) => ({ c, q: Math.round(v.q * 1e6) / 1e6, r: v.r }))
      .sort((a, b) => b.q - a.q)
      .slice(0, MAX_CHANNELS_PER_DAY);
    const channels = JSON.stringify(brief);

    out.bytesBefore += m.bytes;
    out.bytesAfter += channels.length;
    out.daysCompacted += m.days.length;
    out.months++;
    out.monthKeys.push(mk);

    await prisma.$transaction([
      prisma.downstreamChannelDay.deleteMany({
        where: { downstreamId: siteId, day: { in: m.days } },
      }),
      prisma.downstreamChannelDay.upsert({
        where: { downstreamId_day: { downstreamId: siteId, day: mk } },
        create: {
          downstreamId: siteId,
          day: mk,
          granularity: GRANULARITY.month,
          spanDays: m.days.length,
          channels,
          logCount: m.logCount,
          totalQuota: m.totalQuota,
          complete: m.complete,
        },
        update: {
          spanDays: m.days.length,
          channels,
          logCount: m.logCount,
          totalQuota: m.totalQuota,
          complete: m.complete,
          scannedAt: new Date(),
        },
      }),
    ]);
  }

  out.monthKeys.sort();
  return out;
}

/** 一条旧渠道在给定消费量下的成本（人民币） */
export function orphanCostRmb(
  row: {
    costMode: string;
    costRate: number | null;
    costAmountRmb: number | null;
    quota: number;
    quotaPerUnit: number;
    ignored: boolean;
  },
  /** 要算成本的消费量；默认用记录里的累计值 */
  periodQuota?: number,
): number {
  if (row.ignored) return 0;
  const quota = periodQuota ?? row.quota;
  if (row.costMode === ORPHAN_COST_MODE.amount) {
    if (row.costAmountRmb == null) return 0;
    // 总额按消费占比分摊到这个周期
    if (!row.quota) return 0;
    return round2(row.costAmountRmb * (quota / row.quota));
  }
  if (row.costRate == null) return 0;
  const unit = row.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT;
  return round2((quota / unit) * row.costRate);
}

export interface OrphanDetectResult extends ScanResult {
  /** 已删除渠道数 */
  orphans: number;
  created: number;
  aliveChannels: number;
  orphanRevenueRmb: number;
  unresolvedRevenueRmb: number;
  /** 存活渠道列表是否读到；读不到就不能判定删除 */
  channelListLoaded: boolean;
}

/**
 * 检测已删除渠道。
 *
 * 先按需补扫日志（有锚点的天跳过），再拿缓存里出现过的渠道
 * 跟当前存活列表比对 —— 不在列表里的就是被删了。
 *
 * 关键点：比对范围是**全部缓存**而不只是本次区间，
 * 所以以前扫过、当时还存活、现在被删的渠道也能被翻出来。
 */
export async function detectOrphanChannels(
  siteId: string,
  opts: {
    startDay: string;
    endDay: string;
    force?: boolean;
    pageSize?: number;
    maxPages?: number;
    maxDaysPerRun?: number;
  },
): Promise<OrphanDetectResult> {
  const scan = await scanChannelDays(siteId, opts);
  const base: OrphanDetectResult = {
    ...scan,
    orphans: 0,
    created: 0,
    aliveChannels: 0,
    orphanRevenueRmb: 0,
    unresolvedRevenueRmb: 0,
    channelListLoaded: false,
  };
  if (!scan.success) return base;

  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  if (!site) return { ...base, success: false, error: "下游站点不存在" };

  const alive = await fetchDownstreamAliveChannels({
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId ?? 1,
  });
  if (!alive) {
    return {
      ...base,
      success: false,
      error: "读不到渠道列表，无法判断哪些渠道被删除",
    };
  }

  const quotaPerUnit = site.quotaPerDollar || DEFAULT_QUOTA_PER_UNIT;

  // 遍历全部缓存（不限本次区间）—— 以前扫过、当时还活着、
  // 现在被删掉的渠道也要能翻出来
  // 含逐日行与月汇总行；月汇总的 day 是 YYYY-MM，用它的首末日做区间
  const cachedDays = await prisma.downstreamChannelDay.findMany({
    where: { downstreamId: siteId },
    select: { day: true, channels: true, granularity: true },
    orderBy: { day: "asc" },
  });

  const agg = new Map<
    number,
    {
      name: string;
      quota: number;
      requests: number;
      models: Set<string>;
      firstDay: string;
      lastDay: string;
    }
  >();
  for (const d of cachedDays) {
    // 月汇总行的 day 是 YYYY-MM，换成该月首末日参与区间比较
    const isMonth = d.granularity === GRANULARITY.month;
    const from = isMonth ? monthPeriod(`${d.day}-01`).startDay : d.day;
    const to = isMonth ? monthPeriod(`${d.day}-01`).endDay : d.day;

    for (const c of decodeChannels(d.channels)) {
      const cur =
        agg.get(c.c) ||
        {
          name: "",
          quota: 0,
          requests: 0,
          models: new Set<string>(),
          firstDay: from,
          lastDay: to,
        };
      cur.quota += c.q || 0;
      cur.requests += c.r || 0;
      if (c.n) cur.name = c.n;
      for (const m of (c.m || "").split(",")) if (m) cur.models.add(m);
      if (from < cur.firstDay) cur.firstDay = from;
      if (to > cur.lastDay) cur.lastDay = to;
      agg.set(c.c, cur);
    }
  }

  let orphans = 0;
  let created = 0;
  let orphanRevenueRmb = 0;
  let unresolvedRevenueRmb = 0;

  for (const [channelId, a] of agg) {
    if (alive.has(channelId)) continue;
    if (a.quota <= 0) continue;

    orphans++;
    const revenueRmb = a.quota / quotaPerUnit;
    orphanRevenueRmb += revenueRmb;

    const facts = {
      channelName: a.name,
      models:
        [...a.models].sort().slice(0, MAX_MODELS_PER_CHANNEL).join(",") || null,
      quota: a.quota,
      revenueRmb,
      quotaPerUnit,
      requests: a.requests,
      firstDay: a.firstDay,
      lastDay: a.lastDay,
    };

    const existing = await prisma.downstreamOrphanChannel.findUnique({
      where: { downstreamId_channelId: { downstreamId: siteId, channelId } },
    });
    if (existing) {
      // 只更新事实，你填的成本与标记一律不碰
      await prisma.downstreamOrphanChannel.update({
        where: { id: existing.id },
        data: facts,
      });
      if (!existing.ignored && !existing.resolved) unresolvedRevenueRmb += revenueRmb;
    } else {
      await prisma.downstreamOrphanChannel.create({
        data: { downstreamId: siteId, channelId, ...facts },
      });
      created++;
      unresolvedRevenueRmb += revenueRmb;
    }
  }

  return {
    ...scan,
    orphans,
    created,
    aliveChannels: alive.size,
    orphanRevenueRmb: round2(orphanRevenueRmb),
    unresolvedRevenueRmb: round2(unresolvedRevenueRmb),
    channelListLoaded: true,
  };
}

/** 列出旧渠道记录（含当前应计成本） */
export async function listOrphanChannels(siteId?: string) {
  const rows = await prisma.downstreamOrphanChannel.findMany({
    where: siteId ? { downstreamId: siteId } : {},
    orderBy: [{ resolved: "asc" }, { revenueRmb: "desc" }],
    include: { downstream: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    downstreamId: r.downstreamId,
    downstreamName: r.downstream.name,
    channelId: r.channelId,
    channelName: r.channelName,
    models: r.models ? r.models.split(",").filter(Boolean) : [],
    quota: r.quota,
    revenueRmb: round2(r.revenueRmb),
    quotaPerUnit: r.quotaPerUnit,
    requests: r.requests,
    firstDay: r.firstDay,
    lastDay: r.lastDay,
    costMode: r.costMode,
    costRate: r.costRate,
    costAmountRmb: r.costAmountRmb,
    /** 全区间累计成本 */
    costRmb: orphanCostRmb(r),
    resolved: r.resolved,
    ignored: r.ignored,
    note: r.note,
    detectedAt: r.detectedAt,
    marginRmb: round2(r.revenueRmb - orphanCostRmb(r)),
  }));
}

export interface OrphanPeriodCost {
  totalRmb: number;
  /** 逐日成本，画图与逐日核对用 */
  byDay: Map<string, number>;
  unresolvedRevenueRmb: number;
  unresolvedCount: number;
  /** 有几个月只剩月汇总、被按天数比例摊过（结果是估算） */
  estimatedMonths: number;
  entries: {
    id: string;
    downstreamName: string;
    channelId: number;
    channelName: string;
    /** 该周期内的消费（不是全区间累计） */
    revenueRmb: number;
    allocatedRmb: number;
    resolved: boolean;
    ignored: boolean;
  }[];
}

/**
 * 按周期算旧渠道成本。
 *
 * 消费量直接从缓存按天取，所以是**精确**的周期归属，
 * 不需要按天数比例去猜。RATE 按当期消费折算，AMOUNT 按当期消费占比分摊。
 */
export async function orphanCostForPeriod(
  startDay: string,
  endDay: string,
): Promise<OrphanPeriodCost> {
  const orphanRows = await prisma.downstreamOrphanChannel.findMany({
    include: { downstream: { select: { name: true } } },
  });
  const out: OrphanPeriodCost = {
    totalRmb: 0,
    byDay: new Map(),
    unresolvedRevenueRmb: 0,
    unresolvedCount: 0,
    estimatedMonths: 0,
    entries: [],
  };
  if (!orphanRows.length) return out;

  // 逐日行按天精确取；已压缩的月汇总按重叠天数比例摊
  const wanted = new Set(orphanRows.map((r) => `${r.downstreamId}|${r.channelId}`));
  const siteIds = [...new Set(orphanRows.map((r) => r.downstreamId))];
  const months = [...new Set(enumerateDays(startDay, endDay).map(monthKey))];
  const cacheRows = await prisma.downstreamChannelDay.findMany({
    where: {
      downstreamId: { in: siteIds },
      OR: [
        { granularity: GRANULARITY.day, day: { gte: startDay, lte: endDay } },
        { granularity: GRANULARITY.month, day: { in: months } },
      ],
    },
    select: {
      downstreamId: true,
      day: true,
      granularity: true,
      spanDays: true,
      channels: true,
    },
  });

  const byChannel = new Map<string, { quota: number; days: Map<string, number> }>();
  let estimatedMonths = 0;
  for (const d of cacheRows) {
    const isMonth = d.granularity === GRANULARITY.month;
    // 月汇总只有整月总量，按查询区间与该月的重叠天数比例摊
    let factor = 1;
    let anchorDay = d.day;
    if (isMonth) {
      const mp = monthPeriod(`${d.day}-01`);
      const from = mp.startDay > startDay ? mp.startDay : startDay;
      const to = mp.endDay < endDay ? mp.endDay : endDay;
      const covered = inclusiveDays(from, to);
      if (covered <= 0) continue;
      // 分母必须是整月日历天数：月汇总丢了逐日分布，
      // 用实际扫到的天数（spanDays）当分母会把部分区间算成全月。
      const monthDays = inclusiveDays(mp.startDay, mp.endDay);
      factor = Math.min(1, covered / monthDays);
      if (covered < monthDays) estimatedMonths++;
      // 逐日分布已丢失，落在区间起点，图上有个点就够
      anchorDay = from;
    }

    for (const c of decodeChannels(d.channels)) {
      const key = `${d.downstreamId}|${c.c}`;
      if (!wanted.has(key)) continue;
      const quota = (c.q || 0) * factor;
      if (!quota) continue;
      const cur = byChannel.get(key) || { quota: 0, days: new Map<string, number>() };
      cur.quota += quota;
      cur.days.set(anchorDay, (cur.days.get(anchorDay) || 0) + quota);
      byChannel.set(key, cur);
    }
  }

  let total = 0;
  let unresolvedRevenue = 0;
  let unresolvedCount = 0;

  for (const r of orphanRows) {
    const hit = byChannel.get(`${r.downstreamId}|${r.channelId}`);
    if (!hit || hit.quota <= 0) continue;

    const unit = r.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT;
    const periodRevenue = round2(hit.quota / unit);
    const allocated = orphanCostRmb(r, hit.quota);
    total += allocated;

    if (!r.ignored && !r.resolved) {
      unresolvedCount++;
      unresolvedRevenue += periodRevenue;
    }

    // 成本按当天消费占比落到每一天，逐日之和 = 该记录本期成本
    for (const [day, quota] of hit.days) {
      const share = allocated * (quota / hit.quota);
      out.byDay.set(day, round2((out.byDay.get(day) || 0) + share));
    }

    out.entries.push({
      id: r.id,
      downstreamName: r.downstream.name,
      channelId: r.channelId,
      channelName: r.channelName,
      revenueRmb: periodRevenue,
      allocatedRmb: allocated,
      resolved: r.resolved,
      ignored: r.ignored,
    });
  }

  out.entries.sort((a, b) => b.revenueRmb - a.revenueRmb);
  out.totalRmb = round2(total);
  out.unresolvedRevenueRmb = round2(unresolvedRevenue);
  out.unresolvedCount = unresolvedCount;
  out.estimatedMonths = estimatedMonths;
  return out;
}

/** 扫描覆盖情况：哪些天已锚定、哪些天还没扫 */
export async function scanCoverage(
  siteId: string,
  startDay: string,
  endDay: string,
): Promise<{
  anchored: number;
  missing: string[];
  total: number;
  /** 其中有几天只剩月汇总（精度已降级） */
  compacted: number;
}> {
  const today = shanghaiDay();
  const days = enumerateDays(startDay, endDay).filter((d) => d <= today);
  const months = [...new Set(days.map(monthKey))];
  const [dayRows, monthRows] = await Promise.all([
    prisma.downstreamChannelDay.findMany({
      where: {
        downstreamId: siteId,
        granularity: GRANULARITY.day,
        day: { in: days },
        complete: true,
      },
      select: { day: true },
    }),
    prisma.downstreamChannelDay.findMany({
      where: {
        downstreamId: siteId,
        granularity: GRANULARITY.month,
        day: { in: months },
      },
      select: { day: true },
    }),
  ]);
  const done = new Set(dayRows.map((r) => r.day));
  const compactedMonths = new Set(monthRows.map((r) => r.day));
  // 压缩过的月份视为已覆盖（明细已并入月汇总，不需要也不该重扫）
  let compacted = 0;
  for (const d of days) {
    if (done.has(d)) continue;
    if (compactedMonths.has(monthKey(d))) {
      done.add(d);
      compacted++;
    }
  }
  return {
    anchored: done.size,
    missing: days.filter((d) => !done.has(d)),
    total: days.length,
    compacted,
  };
}
