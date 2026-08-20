/**
 * 自建 Sub2API 同步与成本计算（独立于用户侧 JWT 逻辑）
 *
 * 成本/收入口径（按你的说明）：
 * - officialCost：官方 API 记价（usage.total_cost，美元面值）
 * - sellRate：卖出倍率，例如 0.4
 * - 卖出收入 RMB（1:1）= officialCost × sellRate
 * - 账号采购成本：每个反代号手动填 purchaseCostRmb
 * - 统计只纳入 track=true 的分组/账号
 */

import { prisma, parallelUpsert } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { summarizeCosts } from "@/lib/operating-cost";
import { monthPeriod, shanghaiDay } from "@/lib/reporting-period";
import {
  adminListAccounts,
  adminListGroups,
  adminGroupUsageSummary,
  adminDashboardStats,
  adminListUsage,
  adminProbe,
  Sub2AdminError,
} from "@/lib/sub2-admin/client";

/** 全项目统一走 reporting-period 的北京日历日，别在这里再造一份 */
const dayStr = (d = new Date()): string => shanghaiDay(d);

export async function loadAdminProvider(id: string) {
  const p = await prisma.upstreamProvider.findUnique({ where: { id } });
  if (!p) throw new Sub2AdminError("站点不存在", 404);
  if (p.type !== "SUB2_ADMIN") {
    throw new Sub2AdminError("不是自建 Sub2API（SUB2_ADMIN）类型", 400);
  }
  return p;
}

function adminKeyOf(p: { apiKey: string }) {
  const raw = decryptSecret(p.apiKey);
  if (!raw) throw new Sub2AdminError("缺少 Admin API Key", 400);
  return raw;
}

/** 同步分组 + 账号元数据 + 分组用量摘要 */
export async function syncSelfHostedMeta(providerId: string) {
  const provider = await loadAdminProvider(providerId);
  const key = adminKeyOf(provider);

  const [groups, accounts, usageSummary, stats] = await Promise.all([
    adminListGroups(provider.baseUrl, key),
    adminListAccounts(provider.baseUrl, key),
    adminGroupUsageSummary(provider.baseUrl, key),
    adminDashboardStats(provider.baseUrl, key),
  ]);

  const usageByGroup = new Map(
    usageSummary.map((u) => [u.group_id, u]),
  );

  // 分组与账号带用户手填字段（sellRate / track / purchaseCostRmb / notes），
  // 不能删了重建，只能 upsert。逐行 await 在远端库上实测 ~692ms/行，
  // 11 个分组 + 25 个账号就是二十多秒 —— 改成有界并发（~29ms/行）。
  const existingGroups = await prisma.selfHostedGroup.findMany({
    where: { providerId },
    select: { id: true, remoteGroupId: true, sellRate: true },
  });
  const existingGroupByRemote = new Map(
    existingGroups.map((row) => [row.remoteGroupId, row]),
  );
  const syncAt = new Date();

  await parallelUpsert([
    ...groups.map((g) => () => {
      const u = usageByGroup.get(g.id);
      // 默认 sellRate：若远端有 rate_multiplier 且看起来像卖出倍率就用，否则保留已有/0.4
      const remoteRate = Number(g.rate_multiplier ?? 1);
      return prisma.selfHostedGroup.upsert({
        where: {
          providerId_remoteGroupId: {
            providerId,
            remoteGroupId: g.id,
          },
        },
        create: {
          providerId,
          remoteGroupId: g.id,
          name: g.name,
          description: g.description || null,
          platform: g.platform || "",
          sellRate: remoteRate > 0 && remoteRate !== 1 ? remoteRate : 0.4,
          track: false,
          status: g.status || "active",
          lastOfficialCost: u?.total_cost ?? 0,
          todayOfficialCost: u?.today_cost ?? 0,
          lastSyncAt: syncAt,
        },
        update: {
          name: g.name,
          description: g.description || null,
          platform: g.platform || "",
          status: g.status || "active",
          lastOfficialCost: u?.total_cost ?? 0,
          todayOfficialCost: u?.today_cost ?? 0,
          lastSyncAt: syncAt,
          // 不覆盖用户已设的 sellRate / track
        },
      });
    }),
    ...accounts.map((a) => () => {
      const gids = a.group_ids || a.groups?.map((g) => g.id) || [];
      const gnames =
        a.groups?.map((g) => g.name).filter(Boolean).join(", ") || "";
      return prisma.selfHostedAccount.upsert({
        where: {
          providerId_remoteAccountId: {
            providerId,
            remoteAccountId: a.id,
          },
        },
        create: {
          providerId,
          remoteAccountId: a.id,
          name: a.name,
          platform: a.platform || "",
          accountType: a.type || "",
          status: a.status || "active",
          purchaseCostRmb: 0,
          track: false,
          groupIds: JSON.stringify(gids),
          groupNames: gnames,
          lastUsedAt: a.last_used_at ? new Date(a.last_used_at) : null,
          extra: a.extra ? JSON.stringify(a.extra).slice(0, 4000) : null,
        },
        update: {
          name: a.name,
          platform: a.platform || "",
          accountType: a.type || "",
          status: a.status || "active",
          groupIds: JSON.stringify(gids),
          groupNames: gnames,
          lastUsedAt: a.last_used_at ? new Date(a.last_used_at) : null,
          extra: a.extra ? JSON.stringify(a.extra).slice(0, 4000) : null,
          // 不覆盖 purchaseCostRmb / track / notes
        },
      });
    }),
  ]);

  // 若新建时 remote rate 为 1，保持 create 默认 0.4；已存在不改 sellRate。
  // 只修补历史上 sellRate 落成 0 的行，判定用的是本轮开始前读到的快照。
  const rateFixIds = groups
    .map((g) => existingGroupByRemote.get(g.id))
    .filter((row) => row && !row.sellRate)
    .map((row) => row!.id);
  if (rateFixIds.length) {
    await prisma.selfHostedGroup.updateMany({
      where: { id: { in: rateFixIds } },
      data: { sellRate: 0.4 },
    });
  }

  const officialTotal = Number(stats.total_cost || stats.total_actual_cost || 0);
  const todayOfficial = Number(stats.today_cost || stats.today_actual_cost || 0);

  await prisma.upstreamProvider.update({
    where: { id: providerId },
    data: {
      lastConsumed: officialTotal,
      lastBalance: null, // 自建站不是余额模型
      lastSyncAt: new Date(),
      lastError: null,
    },
  });

  return {
    groups: groups.length,
    accounts: accounts.length,
    officialTotal,
    todayOfficial,
  };
}

/**
 * 同步指定日期范围内、已 track 分组的使用明细，写入 SelfHostedGroupDaily
 * 官方 cost → 卖出收入 = official * sellRate
 */
export async function syncSelfHostedGroupUsage(
  providerId: string,
  opts: { startDate: string; endDate: string; maxPages?: number },
) {
  const provider = await loadAdminProvider(providerId);
  const key = adminKeyOf(provider);
  const tracked = await prisma.selfHostedGroup.findMany({
    where: { providerId, track: true },
  });
  if (!tracked.length) {
    return { groups: 0, fetched: 0, message: "没有勾选要统计的分组" };
  }

  let fetched = 0;
  const maxPages = opts.maxPages ?? 30;
  /** 因翻页被截断、只拿到部分数据的「分组×日」数 */
  let partialDays = 0;

  for (const g of tracked) {
    // 按日桶
    const dayBucket = new Map<
      string,
      { requests: number; official: number; actual: number; tokens: number }
    >();

    // 排序是 created_at desc：截断时丢的是**最老**的那几天。
    // 所以被截断后，桶里最老那一天几乎肯定只有半天数据，不能当完整值写回去。
    let truncated = false;
    let oldestSeen: string | null = null;

    for (let page = 1; page <= maxPages; page++) {
      const { items, pages, pagesKnown } = await adminListUsage(
        provider.baseUrl,
        key,
        {
          startDate: opts.startDate,
          endDate: opts.endDate,
          groupId: g.remoteGroupId,
          page,
          pageSize: 100,
        },
      );
      if (!items.length) break;
      for (const it of items) {
        const when = it.created_at ? new Date(it.created_at) : new Date();
        const day = shanghaiDay(when);
        const b = dayBucket.get(day) || {
          requests: 0,
          official: 0,
          actual: 0,
          tokens: 0,
        };
        b.requests += 1;
        b.official += Number(it.total_cost || 0);
        b.actual += Number(it.actual_cost || 0);
        b.tokens += Number(it.total_tokens || 0);
        dayBucket.set(day, b);
        if (!oldestSeen || day < oldestSeen) oldestSeen = day;
        fetched++;
      }
      // 上游报了页数就按它翻；没报就只能看这页是否满页
      const atEnd = pagesKnown ? page >= pages : items.length < 100;
      if (atEnd) break;
      if (page === maxPages) truncated = true;
    }

    // 倍率按行冻结：已入账的日行沿用当时的倍率，只有新行才用当前值。
    // 否则改一次分组倍率就会把所有历史报表重算一遍（会改写历史）。
    // 原来是每天先 findUnique 再 upsert —— 一天两次往返；改成整批一次取回。
    const writableDays = [...dayBucket].filter(([day]) => {
      // 截断时最老那天的数据是残缺的：写回去会把原本完整的合计改小。
      // 宁可保留旧值 —— 少一次更新不会错账，写入半天的数据会。
      const partial = truncated && day === oldestSeen;
      if (partial) partialDays++;
      return !partial;
    });
    const existingDaily = await prisma.selfHostedGroupDaily.findMany({
      where: {
        providerId,
        remoteGroupId: g.remoteGroupId,
        day: { in: writableDays.map(([day]) => day) },
      },
      select: { day: true, sellRateUsed: true },
    });
    const existingDailyByDay = new Map(
      existingDaily.map((row) => [row.day, row]),
    );

    const dailyRows = writableDays.map(([day, b]) => {
      const existing = existingDailyByDay.get(day);
      const frozen = !!(existing && existing.sellRateUsed > 0);
      const rate = frozen ? existing!.sellRateUsed : g.sellRate;
      return {
        providerId,
        remoteGroupId: g.remoteGroupId,
        groupName: g.name,
        day,
        requests: b.requests,
        officialCost: b.official,
        actualCost: b.actual,
        totalTokens: b.tokens,
        // 用量本身会被重新拉取修正，但折算用的倍率保持首次入账时的值
        sellRevenueRmb: b.official * rate,
        sellRateUsed: rate,
        // 迁移前的行没有倍率快照，这次补上当前值并标成 legacy（只会发生一次）
        sellRateSource: existing && !frozen ? "legacy" : "group",
        track: true,
      };
    });

    if (dailyRows.length) {
      await prisma.$transaction([
        prisma.selfHostedGroupDaily.deleteMany({
          where: {
            providerId,
            remoteGroupId: g.remoteGroupId,
            day: { in: dailyRows.map((row) => row.day) },
          },
        }),
        prisma.selfHostedGroupDaily.createMany({ data: dailyRows }),
      ]);
    }

    // 刷新分组累计
    const today = dayStr();
    const [sum, todayRow] = await Promise.all([
      prisma.selfHostedGroupDaily.aggregate({
        where: { providerId, remoteGroupId: g.remoteGroupId },
        _sum: { officialCost: true, requests: true },
      }),
      prisma.selfHostedGroupDaily.findUnique({
        where: {
          providerId_remoteGroupId_day: {
            providerId,
            remoteGroupId: g.remoteGroupId,
            day: today,
          },
        },
      }),
    ]);
    await prisma.selfHostedGroup.update({
      where: { id: g.id },
      data: {
        lastOfficialCost: sum._sum.officialCost ?? g.lastOfficialCost,
        lastRequests: sum._sum.requests ?? g.lastRequests,
        todayOfficialCost: todayRow?.officialCost ?? 0,
        todayRequests: todayRow?.requests ?? 0,
        lastSyncAt: new Date(),
      },
    });
  }

  return {
    groups: tracked.length,
    fetched,
    partialDays,
    ...(partialDays > 0
      ? {
          message: `有 ${partialDays} 个「分组×日」因翻页上限只取到部分记录，已跳过不写入（避免把完整数据改小）。请缩小日期区间后再同步。`,
        }
      : {}),
  };
}

export async function getSelfHostedOverview(providerId: string) {
  const provider = await loadAdminProvider(providerId);
  const [groups, accounts] = await Promise.all([
    prisma.selfHostedGroup.findMany({
      where: { providerId },
      orderBy: { name: "asc" },
    }),
    prisma.selfHostedAccount.findMany({
      where: { providerId },
      orderBy: { name: "asc" },
    }),
  ]);

  const trackedGroups = groups.filter((g) => g.track);
  const trackedAccounts = accounts.filter((a) => a.track);

  // 本月卖出/官方用量（从 daily）
  const period = monthPeriod(dayStr());
  const monthDaily = await prisma.selfHostedGroupDaily.findMany({
    where: {
      providerId,
      track: true,
      day: { gte: period.startDay, lte: period.endDay },
    },
  });

  const monthOfficial = monthDaily.reduce((s, d) => s + d.officialCost, 0);
  const monthSellRmb = monthDaily.reduce((s, d) => s + d.sellRevenueRmb, 0);
  const monthRequests = monthDaily.reduce((s, d) => s + d.requests, 0);
  const accountPurchaseRmb = trackedAccounts.reduce(
    (s, a) => s + (a.purchaseCostRmb || 0),
    0,
  );

  // 本月真正该扣的成本：成本台账（一次性按记账日、期间按有效期摊销）。
  // 账号配置里的采购总价不再每个月整笔扣一遍。
  const costEntries = await prisma.operatingCostEntry.findMany({
    where: {
      status: { not: "void" },
      OR: [{ providerId }, { accountId: { in: accounts.map((a) => a.id) } }],
    },
  });
  const costSummary = summarizeCosts(
    costEntries.map((e) => ({
      id: e.id,
      name: e.name,
      amountRmb: Number(e.amountRmb),
      mode: e.mode,
      startDay: e.startDay,
      plannedEndDay: e.plannedEndDay,
      actualEndDay: e.actualEndDay,
      status: e.status,
      category: e.category,
      providerId: e.providerId,
      accountId: e.accountId,
    })),
    period,
  );

  return {
    provider: {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      lastSyncAt: provider.lastSyncAt,
      lastError: provider.lastError,
      lastConsumed: provider.lastConsumed,
    },
    groups,
    accounts,
    summary: {
      period,
      trackedGroups: trackedGroups.length,
      trackedAccounts: trackedAccounts.length,
      monthOfficialCost: monthOfficial,
      /**
       * 官方用量 × 卖出倍率，仅自建站内部参考。
       * 这批流量的真实收入落在下游 NewAPI 的消费里，别跟总账相加。
       */
      monthSellRevenueRmb: monthSellRmb,
      monthRequests,
      /** 账号里填的采购总价，仅供核对，不参与本月成本 */
      accountPurchaseRmb,
      /** 本月实际入账 / 摊销的额外成本 */
      operatingCostRmb: costSummary.totalRmb,
      operatingCostEntries: costSummary.entries,
      earlyEndedCostEntries: costSummary.earlyEndedCount,
      openEndedCostEntries: costSummary.openEndedCount,
    },
  };
}

export { adminProbe };
