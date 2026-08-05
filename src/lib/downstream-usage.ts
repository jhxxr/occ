/**
 * 下游按日消费同步
 *
 * 写入 DownstreamUsageDaily（收入事实）。
 * 同一天重复同步走 upsert 覆盖，不累加。
 *
 * 收入只算付费账号：测试号（站点里排除掉的那些）的消费另存一列，
 * 用来跟上游成本对差值 —— 它烧了上游额度，但没人付钱。
 *
 * 付费账号再按推广归属拆两层：私域（自己推广的，站点里标记的那些）
 * 与公共池（其余，含朋友推广的）。公共池不单独存，用
 * revenueRmb − privateRevenueRmb 现算，避免两个数各自漂移。
 */

import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  fetchDownstreamDailyUsage,
  listDownstreamUsers,
} from "@/lib/adapters";
import { addDays, assertDay, shanghaiDay } from "@/lib/reporting-period";

/** 收入按人民币口径直接累计：额度面值 ÷ 每元额度单位 */
const DEFAULT_QUOTA_PER_UNIT = 500_000;

export interface DownstreamUsageSyncResult {
  id: string;
  name: string;
  success: boolean;
  days: number;
  groupRows: number;
  /** 付费账号消费（收入） */
  revenueRmb: number;
  /** 其中私域用户的部分 */
  privateRevenueRmb: number;
  /** 其中公共池的部分（含朋友推广的） */
  publicRevenueRmb: number;
  /** 全部账号消费（含测试号），对账用 */
  grossRevenueRmb: number;
  /** 测试号烧掉的部分 */
  excludedRmb: number;
  /** 测试号是否真的拆出来了 */
  excludeResolved: boolean;
  /** 私域是否真的拆出来了 */
  privateResolved: boolean;
  source: string;
  complete: boolean;
  failedDays: string[];


  error?: string;
}

function quotaToRmb(quota: number, quotaPerUnit: number): number {
  if (!quotaPerUnit) return 0;
  return quota / quotaPerUnit;
}

/** 默认回补最近 n 天，兜住延迟落库的日志 */
export function recentDayRange(days = 7): { startDay: string; endDay: string } {
  const endDay = shanghaiDay();
  return { startDay: addDays(endDay, -(Math.max(1, days) - 1)), endDay };
}

export async function syncDownstreamUsage(
  siteId: string,
  opts: { startDay?: string; endDay?: string; days?: number } = {},
): Promise<DownstreamUsageSyncResult> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  if (!site) {
    return {
      id: siteId,
      name: "?",
      success: false,
      days: 0,
      groupRows: 0,
      revenueRmb: 0,
      privateRevenueRmb: 0,
      publicRevenueRmb: 0,
      grossRevenueRmb: 0,
      excludedRmb: 0,
      excludeResolved: false,
      privateResolved: false,
      source: "none",
      complete: false,
      failedDays: [],


      error: "下游站点不存在",
    };
  }

  const fallback = recentDayRange(opts.days ?? 7);
  const startDay = assertDay(opts.startDay || fallback.startDay, "startDay");
  const endDay = assertDay(opts.endDay || fallback.endDay, "endDay");
  if (endDay < startDay) {
    return {
      id: siteId,
      name: site.name,
      success: false,
      days: 0,
      groupRows: 0,
      revenueRmb: 0,
      privateRevenueRmb: 0,
      publicRevenueRmb: 0,
      grossRevenueRmb: 0,
      excludedRmb: 0,
      excludeResolved: false,
      privateResolved: false,
      source: "none",
      complete: false,
      failedDays: [],


      error: "结束日期不能早于开始日期",
    };
  }

  const adminKey = decryptSecret(site.adminKey);
  const quotaPerUnit = site.quotaPerDollar || DEFAULT_QUOTA_PER_UNIT;
  const input = {
    baseUrl: site.baseUrl,
    adminKey,
    adminUserId: site.adminUserId ?? 1,
    quotaPerDollar: quotaPerUnit,
  };

  // 排除名单存的是用户 id，但逐账号消费按 username 聚合，得先换成名字
  let excludeUserIds: number[] = [];
  try {
    const parsed = JSON.parse(site.excludeUserIds || "[]");
    if (Array.isArray(parsed)) {
      excludeUserIds = parsed.map(Number).filter((n) => Number.isFinite(n));
    }
  } catch {
    excludeUserIds = [];
  }

  // 私域名单同理
  let privateUserIds: number[] = [];
  try {
    const parsed = JSON.parse(site.privateUserIds || "[]");
    if (Array.isArray(parsed)) {
      privateUserIds = parsed.map(Number).filter((n) => Number.isFinite(n));
    }
  } catch {
    privateUserIds = [];
  }

  let excludeUsernames: string[] = [];
  let privateUsernames: string[] = [];
  let excludeNamesResolved = excludeUserIds.length === 0;
  let privateNamesResolved = privateUserIds.length === 0;
  if (excludeUserIds.length || privateUserIds.length) {
    const users = await listDownstreamUsers({ ...input, excludeUserIds });
    if (users.success) {
      const wantedExclude = new Set(excludeUserIds);
      // 超管永远算测试号，不进私域
      const excludeIdSet = new Set(
        users.users
          .filter((u) => wantedExclude.has(u.id) || u.role >= 100)
          .map((u) => u.id),
      );
      excludeUsernames = users.users
        .filter((u) => excludeIdSet.has(u.id))
        .map((u) => u.username)
        .filter(Boolean);
      excludeNamesResolved =
        excludeUserIds.length === 0 || excludeUsernames.length > 0;

      // 排除优先：同时在两个名单里的算测试号
      const wantedPrivate = new Set(privateUserIds);
      privateUsernames = users.users
        .filter((u) => wantedPrivate.has(u.id) && !excludeIdSet.has(u.id))
        .map((u) => u.username)
        .filter(Boolean);
      privateNamesResolved =
        privateUserIds.length === 0 || privateUsernames.length > 0;
    }
  }

  const usage = await fetchDownstreamDailyUsage({
    ...input,
    startDay,
    endDay,
    excludeUsernames,
    privateUsernames,
  });

  if (!usage.success) {
    await prisma.downstreamSite.update({
      where: { id: siteId },
      data: {
        lastError: (usage.error || "消费统计同步失败").slice(0, 300),
      },
    });
    return {
      id: siteId,
      name: site.name,
      success: false,
      days: 0,
      groupRows: 0,
      revenueRmb: 0,
      privateRevenueRmb: 0,
      publicRevenueRmb: 0,
      grossRevenueRmb: 0,
      excludedRmb: 0,
      excludeResolved: false,
      privateResolved: false,
      source: usage.totalSource,
      complete: false,
      failedDays: usage.failedDays,
      error: usage.error,
    };
  }

  const excludeResolved = usage.excludeResolved && excludeNamesResolved;
  const privateResolved = usage.privateResolved && privateNamesResolved;

  let revenueRmb = 0;
  let grossRevenueRmb = 0;
  let excludedRmb = 0;
  let privateRevenueRmb = 0;
  for (const row of usage.totals) {
    const grossRmb = quotaToRmb(row.quota, quotaPerUnit);
    const excludedPart = quotaToRmb(row.excludedQuota, quotaPerUnit);
    // 收入只认付费账号；拆不出测试号时保持等于全站，并靠 excludeResolved 提示
    const payingRmb = grossRmb - excludedPart;
    // 私域是付费部分的子集；拆不出来时记 0（而不是当成没有私域）
    const privatePart = quotaToRmb(row.privateQuota, quotaPerUnit);
    grossRevenueRmb += grossRmb;
    excludedRmb += excludedPart;
    revenueRmb += payingRmb;
    privateRevenueRmb += privatePart;

    const data = {
      quota: row.quota,
      excludedQuota: row.excludedQuota,
      privateQuota: row.privateQuota,
      revenueRmb: payingRmb,
      privateRevenueRmb: privatePart,
      grossRevenueRmb: grossRmb,
      quotaPerUnit,
      requests: row.requests,
      excludeResolved,
      privateResolved: privateResolved && row.privateResolved,
      source: usage.totalSource,
      complete: !usage.failedDays.includes(row.day),
      syncedAt: new Date(),
    };
    await prisma.downstreamUsageDaily.upsert({
      where: {
        downstreamId_day_scope_groupName: {
          downstreamId: siteId,
          day: row.day,
          scope: "TOTAL",
          groupName: "",
        },
      },
      create: {
        downstreamId: siteId,
        day: row.day,
        scope: "TOTAL",
        groupName: "",
        ...data,
      },
      update: data,
    });
  }

  // 分组归因：只做拆解展示与倍率法对账，报表求和不读它。
  // 分组维度拿不到账号，所以这里的 revenueRmb 是含测试号的毛值，
  // 私域也无从拆分，一律记 0 + privateResolved=false。
  for (const row of usage.groups) {
    const grossRmb = quotaToRmb(row.quota, quotaPerUnit);
    const data = {
      quota: row.quota,
      excludedQuota: 0,
      privateQuota: 0,
      revenueRmb: grossRmb,
      privateRevenueRmb: 0,
      grossRevenueRmb: grossRmb,
      quotaPerUnit,
      requests: row.requests,
      excludeResolved: false,
      privateResolved: false,
      source: "data-export" as const,
      complete: true,
      syncedAt: new Date(),
    };
    await prisma.downstreamUsageDaily.upsert({
      where: {
        downstreamId_day_scope_groupName: {
          downstreamId: siteId,
          day: row.day,
          scope: "GROUP",
          groupName: row.groupName,
        },
      },
      create: {
        downstreamId: siteId,
        day: row.day,
        scope: "GROUP",
        groupName: row.groupName,
        ...data,
      },
      update: data,
    });
  }

  const notes: string[] = [];
  if (usage.failedDays.length) {
    notes.push(`${usage.failedDays.length} 天消费数据拉取失败`);
  }
  if (!excludeResolved) {
    notes.push("拿不到逐账号消费，测试号未从收入中剔除（需开启数据看板导出）");
  }
  if (!privateResolved) {
    notes.push("拿不到逐账号消费，私域收入未拆分（需开启数据看板导出）");
  }

  await prisma.downstreamSite.update({
    where: { id: siteId },
    data: {
      lastSyncAt: new Date(),
      lastError: notes.length ? notes.join("；").slice(0, 300) : null,
    },
  });

  return {
    id: siteId,
    name: site.name,
    success: true,
    days: usage.totals.length,
    groupRows: usage.groups.length,
    revenueRmb: Math.round(revenueRmb * 100) / 100,
    privateRevenueRmb: Math.round(privateRevenueRmb * 100) / 100,
    publicRevenueRmb: Math.round((revenueRmb - privateRevenueRmb) * 100) / 100,
    grossRevenueRmb: Math.round(grossRevenueRmb * 100) / 100,
    excludedRmb: Math.round(excludedRmb * 100) / 100,
    excludeResolved,
    privateResolved,
    source: usage.totalSource,
    complete: usage.complete,
    failedDays: usage.failedDays,
  };
}

/** 给所有启用站点补最近区间 */
export async function syncAllDownstreamUsage(
  opts: { startDay?: string; endDay?: string; days?: number } = {},
): Promise<DownstreamUsageSyncResult[]> {
  const sites = await prisma.downstreamSite.findMany({ where: { enabled: true } });
  const out: DownstreamUsageSyncResult[] = [];
  for (const s of sites) {
    out.push(await syncDownstreamUsage(s.id, opts));
  }
  return out;
}
