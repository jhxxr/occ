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

import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  adminListAccounts,
  adminListGroups,
  adminGroupUsageSummary,
  adminDashboardStats,
  adminListUsage,
  adminProbe,
  Sub2AdminError,
} from "@/lib/sub2-admin/client";

function dayStr(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

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

  for (const g of groups) {
    const u = usageByGroup.get(g.id);
    const existing = await prisma.selfHostedGroup.findUnique({
      where: {
        providerId_remoteGroupId: {
          providerId,
          remoteGroupId: g.id,
        },
      },
    });

    // 默认 sellRate：若远端有 rate_multiplier 且看起来像卖出倍率就用，否则保留已有/0.4
    const remoteRate = Number(g.rate_multiplier ?? 1);
    await prisma.selfHostedGroup.upsert({
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
        lastSyncAt: new Date(),
      },
      update: {
        name: g.name,
        description: g.description || null,
        platform: g.platform || "",
        status: g.status || "active",
        lastOfficialCost: u?.total_cost ?? 0,
        todayOfficialCost: u?.today_cost ?? 0,
        lastSyncAt: new Date(),
        // 不覆盖用户已设的 sellRate / track
      },
    });

    // 若新建时 remote rate 为 1，保持 create 默认 0.4；已存在不改 sellRate
    if (existing && !existing.sellRate) {
      await prisma.selfHostedGroup.update({
        where: { id: existing.id },
        data: { sellRate: 0.4 },
      });
    }
  }

  for (const a of accounts) {
    const gids = a.group_ids || a.groups?.map((g) => g.id) || [];
    const gnames =
      a.groups?.map((g) => g.name).filter(Boolean).join(", ") || "";
    await prisma.selfHostedAccount.upsert({
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

  for (const g of tracked) {
    // 按日桶
    const dayBucket = new Map<
      string,
      { requests: number; official: number; actual: number; tokens: number }
    >();

    for (let page = 1; page <= maxPages; page++) {
      const { items, pages } = await adminListUsage(provider.baseUrl, key, {
        startDate: opts.startDate,
        endDate: opts.endDate,
        groupId: g.remoteGroupId,
        page,
        pageSize: 100,
      });
      if (!items.length) break;
      for (const it of items) {
        const when = it.created_at ? new Date(it.created_at) : new Date();
        const day = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(when);
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
        fetched++;
      }
      if (page >= pages) break;
    }

    for (const [day, b] of dayBucket) {
      await prisma.selfHostedGroupDaily.upsert({
        where: {
          providerId_remoteGroupId_day: {
            providerId,
            remoteGroupId: g.remoteGroupId,
            day,
          },
        },
        create: {
          providerId,
          remoteGroupId: g.remoteGroupId,
          groupName: g.name,
          day,
          requests: b.requests,
          officialCost: b.official,
          actualCost: b.actual,
          totalTokens: b.tokens,
          sellRevenueRmb: b.official * g.sellRate,
          track: true,
        },
        update: {
          groupName: g.name,
          requests: b.requests,
          officialCost: b.official,
          actualCost: b.actual,
          totalTokens: b.tokens,
          sellRevenueRmb: b.official * g.sellRate,
          track: true,
        },
      });
    }

    // 刷新分组累计
    const sum = await prisma.selfHostedGroupDaily.aggregate({
      where: { providerId, remoteGroupId: g.remoteGroupId },
      _sum: { officialCost: true, requests: true },
    });
    const today = dayStr();
    const todayRow = await prisma.selfHostedGroupDaily.findUnique({
      where: {
        providerId_remoteGroupId_day: {
          providerId,
          remoteGroupId: g.remoteGroupId,
          day: today,
        },
      },
    });
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

  return { groups: tracked.length, fetched };
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
  const monthStart = dayStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const today = dayStr();
  const monthDaily = await prisma.selfHostedGroupDaily.findMany({
    where: {
      providerId,
      track: true,
      day: { gte: monthStart, lte: today },
    },
  });

  const monthOfficial = monthDaily.reduce((s, d) => s + d.officialCost, 0);
  const monthSellRmb = monthDaily.reduce((s, d) => s + d.sellRevenueRmb, 0);
  const monthRequests = monthDaily.reduce((s, d) => s + d.requests, 0);
  const accountPurchaseRmb = trackedAccounts.reduce(
    (s, a) => s + (a.purchaseCostRmb || 0),
    0,
  );

  // 粗算：卖出收入 − 账号采购成本（采购是一次性的，这里展示为库存成本）
  // 更精细的可按账号摊销，先给清晰数字
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
      trackedGroups: trackedGroups.length,
      trackedAccounts: trackedAccounts.length,
      monthOfficialCost: monthOfficial,
      monthSellRevenueRmb: monthSellRmb,
      monthRequests,
      accountPurchaseRmb,
      /** 卖出收入 − 已追踪账号采购成本（采购是资产，仅作参考） */
      roughProfitRmb: monthSellRmb - accountPurchaseRmb,
    },
  };
}

export { adminProbe };
