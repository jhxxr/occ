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
import {
  fetchDownstreamDailyUsageForSite,
  fetchDownstreamModelDailyForSite,
  fetchDownstreamTopupsForSite,
  resolveDownstreamUsernames,
} from "@/lib/downstream-fetch";
import { syncManagedCreditLedger } from "@/lib/downstream-credit-ledger";
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
  const requestedEndDay = assertDay(opts.endDay || fallback.endDay, "endDay");
  if (requestedEndDay < startDay) {
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

  // 区间不能越过今天。报表页发的是整个自然周/月（当月就是 1 号到月底），
  // 而 /api/log/stat 对未来日期照样返回 0，于是这些天会被当成「已同步且
  // 完整」落库：覆盖天数被撑满、missingDays 归零，真实缺口反而被藏住，
  // 趋势图也会拖出一条一直到月底的零线。
  const today = shanghaiDay();
  const endDay = requestedEndDay > today ? today : requestedEndDay;
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


      error: "开始日期晚于今天，没有可同步的数据",
    };
  }

  const quotaPerUnit = site.quotaPerDollar || DEFAULT_QUOTA_PER_UNIT;

  // 排除/私域名单是用户 id；逐账号消费按 username 聚合，先解析名字（绑库走 DB）
  const {
    excludeUsernames,
    privateUsernames,
    excludeNamesResolved,
    privateNamesResolved,
  } = await resolveDownstreamUsernames(site);

  const usage = await fetchDownstreamDailyUsageForSite(site, {
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
  // 这张表也是纯派生的：整段重算比逐行 upsert 快两个数量级（见 db.ts 的说明）。
  // 一轮同步共用一个 syncedAt。
  const syncedAt = new Date();
  const totalRows = [];
  const groupRows = [];
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

    totalRows.push({
      downstreamId: siteId,
      day: row.day,
      scope: "TOTAL",
      groupName: "",
      quota: row.quota,
      excludedQuota: row.excludedQuota,
      privateQuota: row.privateQuota,
      revenueRmb: payingRmb,
      privateRevenueRmb: privatePart,
      grossRevenueRmb: grossRmb,
      quotaPerUnit,
      requests: row.requests,
      // 逐日判定，不能用站点级的汇总值覆盖：NewAPI 的逐账号聚合是滞后的，
      // 当天经常拿不到，这时整站消费会原样记成付费收入。用汇总值盖上去
      // 等于给这一行盖章「测试号已剔除」，警告不触发、徽章还是绿的。
      excludeResolved: excludeResolved && row.excludeResolved,
      privateResolved: privateResolved && row.privateResolved,
      source: usage.totalSource,
      complete: !usage.failedDays.includes(row.day),
      syncedAt,
    });
  }

  // 分组归因：只做拆解展示与倍率法对账，报表求和不读它。
  // 分组维度拿不到账号，所以这里的 revenueRmb 是含测试号的毛值，
  // 私域也无从拆分，一律记 0 + privateResolved=false。
  for (const row of usage.groups) {
    const grossRmb = quotaToRmb(row.quota, quotaPerUnit);
    groupRows.push({
      downstreamId: siteId,
      day: row.day,
      scope: "GROUP",
      groupName: row.groupName,
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
      source: "data-export",
      complete: true,
      syncedAt,
    });
  }

  // 删除条件必须**恰好**等于要写回的键集合。
  // TOTAL 的 groupName 固定是空串，按天删就是精确的；
  // GROUP 还要按天列出分组名 —— 这轮没被报出来的分组（改名、下架、
  // 历史遗留的空名行）不该被顺手清掉，原来的逐行 upsert 从不删任何行。
  const writes = [];
  if (totalRows.length) {
    const days = [...new Set(totalRows.map((row) => row.day))];
    writes.push(
      prisma.downstreamUsageDaily.deleteMany({
        where: {
          downstreamId: siteId,
          scope: "TOTAL",
          groupName: "",
          day: { in: days },
        },
      }),
      prisma.downstreamUsageDaily.createMany({ data: totalRows }),
    );
  }
  if (groupRows.length) {
    const groupsByDay = new Map<string, Set<string>>();
    for (const row of groupRows) {
      let names = groupsByDay.get(row.day);
      if (!names) {
        names = new Set();
        groupsByDay.set(row.day, names);
      }
      names.add(row.groupName);
    }
    writes.push(
      prisma.downstreamUsageDaily.deleteMany({
        where: {
          downstreamId: siteId,
          scope: "GROUP",
          OR: [...groupsByDay].map(([day, names]) => ({
            day,
            groupName: { in: [...names] },
          })),
        },
      }),
      prisma.downstreamUsageDaily.createMany({ data: groupRows }),
    );
  }
  if (writes.length) await prisma.$transaction(writes);

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

  const ledger = await syncManagedCreditLedger(siteId);
  if (!ledger.success) {
    notes.push(`赠送额度分摊失败：${ledger.error || "未知错误"}`);
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
  for (const site of sites) {
    const res = await syncDownstreamUsage(site.id, opts);
    out.push(res);
  }
  return out;
}

/**
 * 同步单站点按模型×归属的日用量。
 *
 * 写入 DownstreamModelDaily：每天每个模型三行（TOTAL/PRIVATE/PUBLIC）。
 * 用于报表按模型成本率算私域/公共各自的真实成本，比收入占比摊法精准。
 */
export async function syncDownstreamModelUsage(
  downstreamId: string,
  opts: { startDay?: string; endDay?: string; days?: number } = {},
): Promise<{ success: boolean; synced: number; error?: string }> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: downstreamId } });
  if (!site) return { success: false, synced: 0, error: "站点不存在" };

  const fallback = recentDayRange(opts.days ?? 7);
  const startDay = assertDay(opts.startDay || fallback.startDay, "startDay");
  const requestedEndDay = assertDay(opts.endDay || fallback.endDay, "endDay");
  if (requestedEndDay < startDay) {
    return { success: false, synced: 0, error: "结束日期不能早于开始日期" };
  }
  // 同上：不扫未来日期，否则白翻一遍日志再写一堆零行
  const endDay =
    requestedEndDay > shanghaiDay() ? shanghaiDay() : requestedEndDay;
  if (endDay < startDay) {
    return { success: false, synced: 0, error: "开始日期晚于今天，没有可同步的数据" };
  }

  const {
    excludeUsernames,
    privateUsernames,
    usersResult,
  } = await resolveDownstreamUsernames(site);
  if (!usersResult.success) {
    return {
      success: false,
      synced: 0,
      error: usersResult.error || "拿不到用户列表",
    };
  }

  // 拉模型日用量（绑库时一次 SQL 聚合，不再翻 /api/log）
  const result = await fetchDownstreamModelDailyForSite(site, {
    startDay,
    endDay,
    excludeUsernames,
    privateUsernames,
  });

  if (!result.success) {
    return { success: false, synced: 0, error: result.error };
  }

  // 写库：每个 (天, 模型) 写三行。
  //
  // 这张表是纯派生的（quota/requests 全部来自本轮拉取，没有用户手填字段），
  // 所以整段重算：删掉本轮要重写的键，再一条 createMany 灌回去。
  // 逐行 upsert 在远端库上实测 ~692ms/行，一个 7 天区间 189 行要 18 秒；
  // 这样写是 ~7ms/行。
  //
  // 删除条件必须**恰好**等于要写回的键集合，所以按天列出该天的模型，
  // 而不是 `day in 区间`：某个模型这轮没被上游报出来（限流、改名、下架），
  // 它那天的历史归因不该跟着一起消失 —— 原来的逐行 upsert 从不删任何行。
  const modelsByDay = new Map<string, Set<string>>();
  for (const row of result.rows) {
    let models = modelsByDay.get(row.day);
    if (!models) {
      models = new Set();
      modelsByDay.set(row.day, models);
    }
    models.add(row.model);
  }
  const rows = result.rows.flatMap((row) => [
    {
      downstreamId,
      day: row.day,
      model: row.model,
      scope: "TOTAL",
      quota: row.privateQuota + row.publicQuota,
      requests: row.privateRequests + row.publicRequests,
    },
    {
      downstreamId,
      day: row.day,
      model: row.model,
      scope: "PRIVATE",
      quota: row.privateQuota,
      requests: row.privateRequests,
    },
    {
      downstreamId,
      day: row.day,
      model: row.model,
      scope: "PUBLIC",
      quota: row.publicQuota,
      requests: row.publicRequests,
    },
  ]);

  if (rows.length) {
    // 删与建同一个事务：分两次提交时中间那一瞬这些行是空的，
    // 恰好被报表读到就会看见模型成本凭空归零。
    await prisma.$transaction([
      prisma.downstreamModelDaily.deleteMany({
        where: {
          downstreamId,
          OR: [...modelsByDay].map(([day, models]) => ({
            day,
            model: { in: [...models] },
          })),
        },
      }),
      prisma.downstreamModelDaily.createMany({ data: rows }),
    ]);
  }

  return { success: true, synced: rows.length };
}

export interface DownstreamTopupSyncResult {
  id: string;
  name: string;
  success: boolean;
  synced: number;
  total: number;
  complete: boolean;
  error?: string;
}

/** 同步单个下游的充值订单；远端唯一键保证重复执行不会重复入账。 */
export async function syncDownstreamTopups(
  siteId: string,
): Promise<DownstreamTopupSyncResult> {
  const site = await prisma.downstreamSite.findUnique({ where: { id: siteId } });
  if (!site) {
    return {
      id: siteId,
      name: "?",
      success: false,
      synced: 0,
      total: 0,
      complete: false,
      error: "下游站点不存在",
    };
  }

  const fetched = await fetchDownstreamTopupsForSite(site);
  const now = new Date();

  if (!fetched.success) {
    await prisma.downstreamSite.update({
      where: { id: siteId },
      data: {
        topupLastSyncAt: now,
        topupSyncError: fetched.error || "充值订单同步失败",
      },
    });
    return {
      id: siteId,
      name: site.name,
      success: false,
      synced: 0,
      total: fetched.total,
      complete: false,
      error: fetched.error,
    };
  }

  // 整段重建，删除范围只取本轮拉到的 remoteId：远端已删除的订单在本地留着
  // （历史入账凭据不该因为对方清库就消失），与原来的 upsert 行为一致。
  if (fetched.rows.length) {
    await prisma.$transaction([
      prisma.downstreamTopup.deleteMany({
        where: {
          downstreamId: siteId,
          remoteId: { in: fetched.rows.map((row) => row.remoteId) },
        },
      }),
      prisma.downstreamTopup.createMany({
        data: fetched.rows.map((row) => ({
          downstreamId: siteId,
          remoteId: row.remoteId,
          userId: row.userId,
          tradeNo: row.tradeNo,
          amount: row.amount,
          moneyRmb: row.moneyRmb,
          status: row.status,
          paymentMethod: row.paymentMethod,
          paymentProvider: row.paymentProvider,
          source: row.source,
          sourceRaw: row.sourceRaw,
          createdAtRemote: row.createdAt,
          completedAt: row.completedAt,
          syncedAt: now,
        })),
      }),
    ]);
  }

  await prisma.downstreamSite.update({
    where: { id: siteId },
    data: {
      topupBackfillComplete: site.topupBackfillComplete || fetched.complete,
      topupLastSyncAt: now,
      topupSyncError: fetched.complete
        ? null
        : fetched.error || "充值订单历史回填不完整",
    },
  });

  return {
    id: siteId,
    name: site.name,
    success: true,
    synced: fetched.rows.length,
    total: fetched.total,
    complete: fetched.complete,
    error: fetched.complete ? undefined : fetched.error || "充值订单历史回填不完整",
  };
}

export async function syncAllDownstreamTopups(): Promise<DownstreamTopupSyncResult[]> {
  const sites = await prisma.downstreamSite.findMany({ where: { enabled: true } });
  const out: DownstreamTopupSyncResult[] = [];
  for (const site of sites) out.push(await syncDownstreamTopups(site.id));
  return out;
}

/** 给所有启用站点补模型级用量 */
export async function syncAllDownstreamModelUsage(
  opts: { startDay?: string; endDay?: string; days?: number } = {},
): Promise<{ success: boolean; synced: number; error?: string }[]> {
  const sites = await prisma.downstreamSite.findMany({ where: { enabled: true } });
  const out: { success: boolean; synced: number; error?: string }[] = [];
  for (const site of sites) {
    const res = await syncDownstreamModelUsage(site.id, opts);
    out.push(res);
  }
  return out;
}
