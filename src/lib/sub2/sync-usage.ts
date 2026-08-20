/**
 * Sub2API 使用记录同步 → 本地明细库 + 按日聚合
 * 数据源：GET /api/v1/usage?start_date&end_date&page&api_key_id
 */

import { prisma, parallelUpsert } from "@/lib/db";
import { sub2Request } from "@/lib/sub2/client";

export interface UsageSyncOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  apiKeyId?: number;
  /** 最多拉取页数，防止一次拉爆；默认 50 页 × 100 = 5000 条 */
  maxPages?: number;
  pageSize?: number;
  timezone?: string;
}

export interface UsageSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  pages: number;
  daysRebuilt: number;
  range: { startDate: string; endDate: string };
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** 把带时区的时间戳归一成 Asia/Shanghai 日历日 YYYY-MM-DD */
export function toShanghaiDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  // en-CA → YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

interface RemoteUsageItem {
  id: number;
  api_key_id?: number;
  api_key?: { id?: number; name?: string } | null;
  model?: string;
  group_id?: number;
  group?: { id?: number; name?: string } | null;
  actual_cost?: number;
  total_cost?: number;
  rate_multiplier?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  request_type?: string;
  stream?: boolean;
  duration_ms?: number;
  created_at?: string;
}

/** 把一条远端明细整理成待写入行。raw 只在未归档时写回，见下方 update 分支。 */
function prepareUsageRow(
  item: RemoteUsageItem,
  keyNameByRemote: Map<string, string>,
) {
  const remoteId = String(item.id);
  const remoteKeyId =
    item.api_key_id != null
      ? String(item.api_key_id)
      : item.api_key?.id != null
        ? String(item.api_key.id)
        : null;
  const requestAt = item.created_at ? new Date(item.created_at) : new Date();
  const day = toShanghaiDay(requestAt);
  const keyName =
    (remoteKeyId && keyNameByRemote.get(remoteKeyId)) ||
    item.api_key?.name ||
    null;
  const inputTokens = Math.round(num(item.input_tokens));
  const outputTokens = Math.round(num(item.output_tokens));
  const cacheReadTokens = Math.round(num(item.cache_read_tokens));

  const structuredRow = {
    remoteKeyId,
    keyName,
    model: str(item.model),
    groupId: item.group_id ?? item.group?.id ?? null,
    groupName: item.group?.name || null,
    actualCost: num(item.actual_cost),
    standardCost: num(item.total_cost),
    rateMultiplier:
      item.rate_multiplier != null ? num(item.rate_multiplier) : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens:
      Math.round(num(item.total_tokens)) ||
      inputTokens + outputTokens + cacheReadTokens,
    requestType: str(item.request_type),
    stream: !!item.stream,
    durationMs:
      item.duration_ms != null ? Math.round(num(item.duration_ms)) : null,
    requestAt,
    day,
  };

  return {
    remoteId,
    day,
    structuredRow,
    row: { ...structuredRow, raw: JSON.stringify(item).slice(0, 4000) },
  };
}

type PreparedUsageRow = ReturnType<typeof prepareUsageRow>;

/**
 * 增量同步使用记录到本地库，并重建受影响日期的日聚合。
 */
export async function syncUsageLogs(
  providerId: string,
  opts: UsageSyncOptions,
): Promise<UsageSyncResult> {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  if (!provider) throw new Error("上游不存在");
  if (provider.type !== "SUB2API") {
    throw new Error("目前仅支持 Sub2API 使用记录同步");
  }
  if (provider.retiredAt) {
    throw new Error("该上游已弃用，只能查询本地历史，不能继续远端同步");
  }

  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const timezone = opts.timezone ?? "Asia/Shanghai";

  let page = 1;
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  const touchedDays = new Set<string>();

  // 本地 key 名缓存
  const localKeys = await prisma.upstreamApiKey.findMany({
    where: { providerId },
  });
  const keyNameByRemote = new Map(
    localKeys.map((k) => [k.remoteKeyId, k.name]),
  );
  const countAsCostByRemote = new Map(
    localKeys.map((k) => [k.remoteKeyId, k.countAsCost]),
  );

  while (page <= maxPages) {
    const q = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      start_date: opts.startDate,
      end_date: opts.endDate,
      timezone,
      sort_by: "created_at",
      sort_order: "desc",
    });
    if (opts.apiKeyId) q.set("api_key_id", String(opts.apiKeyId));

    const data = await sub2Request<{
      items?: RemoteUsageItem[];
      total?: number;
      page?: number;
      page_size?: number;
      pages?: number;
    }>(providerId, `/usage?${q.toString()}`);

    const items = data.items || [];
    if (!items.length) break;

    // 整页一次性判「已存在」，再打包写。原来是每条明细先 findUnique 再
    // create/update —— 一条两次数据库往返，一页 100 条就是 200 次。
    //
    // 同一页里出现重复 remoteId 时必须先去重：逐条写时第二条会读到刚写入的
    // 行走 update 分支，打包写则会变成两条 create，直接撞唯一键让整个事务回滚。
    // 保留后出现的那条，与逐条写「后写覆盖前写」的结果一致。
    const rowByRemoteId = new Map<string, PreparedUsageRow>();
    for (const item of items) {
      const prepared = prepareUsageRow(item, keyNameByRemote);
      touchedDays.add(prepared.day);
      rowByRemoteId.set(prepared.remoteId, prepared);
    }
    const pageRows = [...rowByRemoteId.values()];

    const existingRows = await prisma.upstreamUsageLog.findMany({
      where: { providerId, remoteId: { in: pageRows.map((r) => r.remoteId) } },
      select: { id: true, remoteId: true, archivedAt: true },
    });
    const existingByRemote = new Map(
      existingRows.map((row) => [row.remoteId, row]),
    );

    // 新行走一条 createMany；已存在的行只能逐条 update ——
    // archivedAt / archiveId / raw 是归档状态，删了重建会把审计副本的指针弄丢。
    // 逐条 await 在远端库上太慢，改成有界并发。
    const fresh = pageRows.filter((r) => !existingByRemote.has(r.remoteId));
    if (fresh.length) {
      await prisma.upstreamUsageLog.createMany({
        data: fresh.map(({ remoteId, row }) => ({ providerId, remoteId, ...row })),
      });
      inserted += fresh.length;
    }
    const stale = pageRows.filter((r) => existingByRemote.has(r.remoteId));
    await parallelUpsert(
      stale.map(({ remoteId, structuredRow, row }) => () => {
        const existing = existingByRemote.get(remoteId)!;
        return prisma.upstreamUsageLog.update({
          where: { id: existing.id },
          // 归档是不可变审计副本；重复同步只刷新在线结构化字段，
          // 不能把已压缩的 raw 重新塞回数据库并绕过后续清理。
          data: existing.archivedAt ? structuredRow : row,
        });
      }),
    );
    updated += stale.length;
    fetched += pageRows.length;

    const totalPages =
      data.pages ||
      (data.total && data.page_size
        ? Math.ceil(data.total / data.page_size)
        : page);
    if (page >= totalPages || items.length < pageSize) break;
    page++;
  }

  // 重建受影响日的聚合
  let daysRebuilt = 0;
  for (const day of touchedDays) {
    await rebuildDailyForDay(providerId, day, countAsCostByRemote, provider.discountRate);
    daysRebuilt++;
  }

  // Key 累计消费只由 syncSub2ApiKeys 的远端 total_actual_cost 推进。
  // 不能用本地明细求和覆盖：旧明细归档删除后，本地和天然小于历史累计。

  return {
    fetched,
    inserted,
    updated,
    pages: page,
    daysRebuilt,
    range: { startDate: opts.startDate, endDate: opts.endDate },
  };
}

async function rebuildDailyForDay(
  providerId: string,
  day: string,
  countAsCostByRemote: Map<string, boolean>,
  discountRate: number,
) {
  const logs = await prisma.upstreamUsageLog.findMany({
    where: { providerId, day },
  });

  // group by remoteKeyId
  const buckets = new Map<
    string,
    {
      keyName: string;
      requests: number;
      actualCost: number;
      standardCost: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
    }
  >();

  for (const log of logs) {
    const kid = log.remoteKeyId || "";
    const b = buckets.get(kid) || {
      keyName: log.keyName || "",
      requests: 0,
      actualCost: 0,
      standardCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    b.requests += 1;
    b.actualCost += log.actualCost || 0;
    b.standardCost += log.standardCost || 0;
    b.totalTokens += log.totalTokens || 0;
    b.inputTokens += log.inputTokens || 0;
    b.outputTokens += log.outputTokens || 0;
    if (log.keyName) b.keyName = log.keyName;
    buckets.set(kid, b);
  }

  // 已入账的成本率保持原样：日后改站点折扣率不该把历史成本重算一遍
  const existing = await prisma.upstreamUsageDaily.findMany({
    where: { providerId, day },
  });
  const frozenRate = new Map(
    existing
      .filter((row) => row.costRateRmb > 0)
      .map((row) => [row.remoteKeyId, row.costRateRmb]),
  );

  // 清掉该日旧聚合再写（简单可靠）。删 + 建放进同一个事务：
  // 分两次自动提交时，中间那一瞬这一天的聚合是空的，恰好被报表读到就会
  // 看见成本凭空归零。
  await prisma.$transaction([
    prisma.upstreamUsageDaily.deleteMany({ where: { providerId, day } }),
    ...[...buckets].map(([remoteKeyId, b]) => {
      const countAsCost = countAsCostByRemote.get(remoteKeyId) ?? false;
      const rate = frozenRate.get(remoteKeyId) ?? discountRate;
      return prisma.upstreamUsageDaily.create({
        data: {
          providerId,
          remoteKeyId,
          keyName: b.keyName,
          day,
          requests: b.requests,
          actualCost: b.actualCost,
          standardCost: b.standardCost,
          totalTokens: b.totalTokens,
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          costRmb: countAsCost ? b.actualCost * rate : 0,
          costRateRmb: rate,
          costRateSource: frozenRate.has(remoteKeyId) ? "frozen" : "provider",
          countAsCost,
        },
      });
    }),
  ]);
}

/** 查询本地使用明细 */
export async function queryUsageLogs(
  providerId: string,
  opts: {
    startDate?: string;
    endDate?: string;
    remoteKeyId?: string;
    model?: string;
    page?: number;
    pageSize?: number;
  },
) {
  const page = opts.page ?? 1;
  const pageSize = Math.min(opts.pageSize ?? 50, 200);
  const where: Record<string, unknown> = { providerId };
  if (opts.remoteKeyId) where.remoteKeyId = opts.remoteKeyId;
  if (opts.model) where.model = { contains: opts.model };
  if (opts.startDate || opts.endDate) {
    where.day = {};
    if (opts.startDate)
      (where.day as Record<string, string>).gte = opts.startDate;
    if (opts.endDate) (where.day as Record<string, string>).lte = opts.endDate;
  }

  const [total, items] = await Promise.all([
    prisma.upstreamUsageLog.count({ where }),
    prisma.upstreamUsageLog.findMany({
      where,
      orderBy: { requestAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, items };
}

/** 本地统计：按 key / 按日 / 合计 */
export async function queryUsageStats(
  providerId: string,
  opts: { startDate?: string; endDate?: string; onlyBillable?: boolean },
) {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  const discountRate = provider?.discountRate ?? 7.2;

  const dayWhere: Record<string, unknown> = { providerId };
  if (opts.startDate || opts.endDate) {
    dayWhere.day = {};
    if (opts.startDate)
      (dayWhere.day as Record<string, string>).gte = opts.startDate;
    if (opts.endDate)
      (dayWhere.day as Record<string, string>).lte = opts.endDate;
  }
  if (opts.onlyBillable) dayWhere.countAsCost = true;

  const dailies = await prisma.upstreamUsageDaily.findMany({
    where: dayWhere,
    orderBy: { day: "asc" },
  });

  const byKey = new Map<
    string,
    {
      remoteKeyId: string;
      keyName: string;
      requests: number;
      actualCost: number;
      costRmb: number;
      totalTokens: number;
      countAsCost: boolean;
    }
  >();
  const byDay = new Map<
    string,
    { day: string; requests: number; actualCost: number; costRmb: number }
  >();

  let totalRequests = 0;
  let totalActualCost = 0;
  let totalCostRmb = 0;
  let totalTokens = 0;

  for (const d of dailies) {
    totalRequests += d.requests;
    totalActualCost += d.actualCost;
    totalCostRmb += d.costRmb;
    totalTokens += d.totalTokens;

    const k = byKey.get(d.remoteKeyId) || {
      remoteKeyId: d.remoteKeyId,
      keyName: d.keyName,
      requests: 0,
      actualCost: 0,
      costRmb: 0,
      totalTokens: 0,
      countAsCost: d.countAsCost,
    };
    k.requests += d.requests;
    k.actualCost += d.actualCost;
    k.costRmb += d.costRmb;
    k.totalTokens += d.totalTokens;
    k.countAsCost = d.countAsCost;
    if (d.keyName) k.keyName = d.keyName;
    byKey.set(d.remoteKeyId, k);

    const day = byDay.get(d.day) || {
      day: d.day,
      requests: 0,
      actualCost: 0,
      costRmb: 0,
    };
    day.requests += d.requests;
    day.actualCost += d.actualCost;
    day.costRmb += d.costRmb;
    byDay.set(d.day, day);
  }

  return {
    discountRate,
    summary: {
      requests: totalRequests,
      actualCost: totalActualCost,
      costRmb: totalCostRmb,
      totalTokens,
    },
    byKey: [...byKey.values()].sort((a, b) => b.actualCost - a.actualCost),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/**
 * 当 countAsCost 变更时，重算相关日聚合的 costRmb。
 *
 * 只改「算不算业务成本」，成本率沿用当日已冻结的值；
 * 没有冻结值的历史行（迁移前写入的）才回退到站点当前折扣率。
 */
export async function recomputeCostFlags(providerId: string) {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  if (!provider) return;
  const [keys, boundKeys] = await Promise.all([
    prisma.upstreamApiKey.findMany({ where: { providerId } }),
    prisma.upstreamBoundKey.findMany({ where: { providerId, removedAt: null } }),
  ]);
  const map = new Map([
    ...keys.map((k) => [k.remoteKeyId, k.countAsCost] as const),
    ...boundKeys.map((k) => [k.id, k.countAsCost] as const),
  ]);

  const dailies = await prisma.upstreamUsageDaily.findMany({
    where: { providerId },
  });
  for (const d of dailies) {
    const countAsCost = map.get(d.remoteKeyId) ?? false;
    const rate = d.costRateRmb > 0 ? d.costRateRmb : provider.discountRate;
    await prisma.upstreamUsageDaily.update({
      where: { id: d.id },
      data: {
        countAsCost,
        costRmb: countAsCost ? d.actualCost * rate : 0,
        costRateRmb: rate,
        costRateSource: d.costRateRmb > 0 ? d.costRateSource : "legacy",
      },
    });
  }
}
