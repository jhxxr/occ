/**
 * 纯函数自检：周期边界 + 成本摊销
 *
 * 项目没有测试框架，这里用 node --experimental-strip-types 直接跑，
 * 覆盖计划里点名的边界：自然周一~周日、月末、跨月摊销、提前结束压缩、
 * 一次性只落记账日所在周期。
 *
 *   node --experimental-strip-types scripts/check-reporting.ts
 */

import assert from "node:assert/strict";
import {
  addDays,
  customPeriod,
  elapsedDays,
  elapsedPeriod,
  enumerateDays,
  inclusiveDays,
  monthPeriod,
  overlapDays,
  shiftPeriod,
  weekPeriod,
} from "../src/lib/reporting-period.ts";
import { allocateCostEntry, summarizeCosts } from "../src/lib/operating-cost.ts";
import { buildDailySeries } from "../src/lib/profit.ts";
import { shanghaiDay } from "../src/lib/reporting-period.ts";
import { encryptSecret, decryptSecret } from "../src/lib/crypto.ts";
import { createSessionToken, verifySessionToken } from "../src/lib/auth.ts";
import { verifySessionTokenEdge } from "../src/lib/auth-edge.ts";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  __resetRateLimit,
  RATE_LIMIT_TUNING as RL,
} from "../src/lib/rate-limit.ts";
import {
  resolveConsumedBaseline,
  shouldSkipAccountFallback,
} from "../src/lib/upstream-baseline.ts";
import {
  readJson,
  summarizeSyncJob,
  syncProgressLabel,
} from "../src/lib/sync-client.ts";
import {
  HOST_GATE_TUNING as HG,
  noteRateLimited,
  sawRateLimitSince,
  withHostGate,
  __resetHostGate,
} from "../src/lib/http/host-gate.ts";
import {
  AUTO_SYNC_TUNING as AS,
  backoffMs,
  classifyFailure,
  nextRunAt,
  normalizeAutoSyncConfig,
  selectDueTargets,
  type BackoffMap,
} from "../src/lib/auto-sync.ts";
import {
  SYNC_JOB_TUNING as SJ,
  __withStaleCheck,
  type SyncJob,
} from "../src/lib/sync-runner.ts";
import {
  isTokenExpired,
  resolveExpiry,
  DEFAULT_TOKEN_TTL_DAYS,
  MAX_TOKEN_TTL_DAYS,
} from "../src/lib/extension-token.ts";
import { allocateOwnershipCosts } from "../src/lib/cost-allocation.ts";
import {
  classifyPrepaidUser,
  summarizeBonusRemaining,
  summarizePrepaid,
  summarizePrepaidLiability,
} from "../src/lib/prepaid.ts";
import { estimatePrepaidFulfillment } from "../src/lib/capital-plan.ts";
import {
  __resetGiftIssuanceLimit,
  checkGiftIssuanceAllowed,
  GIFT_ISSUANCE_LIMITS,
  recordGiftIssuance,
  validateGiftIssuanceValue,
} from "../src/lib/gift-issuance-limit.ts";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** 节流闸门这类行为只能在真实时间轴上验证，所以要一个异步版 */
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("周期边界");

check("自然周是周一至周日", () => {
  // 2026-07-30 是周四
  const w = weekPeriod("2026-07-30");
  assert.equal(w.startDay, "2026-07-27");
  assert.equal(w.endDay, "2026-08-02");
  assert.equal(w.days, 7);
});

check("周一当天不会回退到上一周", () => {
  const w = weekPeriod("2026-07-27");
  assert.equal(w.startDay, "2026-07-27");
});

check("周日归属当周而非下一周", () => {
  const w = weekPeriod("2026-08-02");
  assert.equal(w.startDay, "2026-07-27");
  assert.equal(w.endDay, "2026-08-02");
});

check("自然月覆盖到月末", () => {
  assert.equal(monthPeriod("2026-07-15").endDay, "2026-07-31");
  assert.equal(monthPeriod("2026-02-10").endDay, "2026-02-28");
  assert.equal(monthPeriod("2024-02-10").endDay, "2024-02-29");
  assert.equal(monthPeriod("2026-12-01").endDay, "2026-12-31");
});

check("上一/下一周期正确平移", () => {
  assert.equal(shiftPeriod(weekPeriod("2026-07-30"), -1).startDay, "2026-07-20");
  assert.equal(shiftPeriod(monthPeriod("2026-01-15"), -1).startDay, "2025-12-01");
  assert.equal(shiftPeriod(monthPeriod("2026-03-31"), -1).endDay, "2026-02-28");
  assert.equal(shiftPeriod(monthPeriod("2026-12-05"), 1).startDay, "2027-01-01");
});

check("跨月、跨年加减天数", () => {
  assert.equal(addDays("2026-07-31", 1), "2026-08-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(inclusiveDays("2026-07-01", "2026-07-31"), 31);
  assert.equal(inclusiveDays("2026-07-05", "2026-07-04"), 0);
  assert.equal(enumerateDays("2026-07-30", "2026-08-01").length, 3);
});

check("重叠天数", () => {
  assert.equal(overlapDays("2026-07-01", "2026-07-31", "2026-07-15", "2026-08-15"), 17);
  assert.equal(overlapDays("2026-07-01", "2026-07-10", "2026-08-01", "2026-08-10"), 0);
});

check("非法日期被拒绝", () => {
  assert.throws(() => weekPeriod("2026-02-31"));
  assert.throws(() => weekPeriod("2026-7-1"));
  assert.throws(() => customPeriod("2026-07-10", "2026-07-01"));
});

check("已过天数只算到今天", () => {
  const july = monthPeriod("2026-07-15");
  assert.equal(elapsedDays(july, "2026-07-10"), 10);
  assert.equal(elapsedDays(july, "2026-08-20"), 31);
  assert.equal(elapsedDays(july, "2026-06-20"), 0);
});

check("当前周期只截取到今天，未来周期没有已发生区间", () => {
  const august = monthPeriod("2026-08-15");
  const elapsed = elapsedPeriod(august, "2026-08-19");
  assert.equal(elapsed?.startDay, "2026-08-01");
  assert.equal(elapsed?.endDay, "2026-08-19");
  assert.equal(elapsed?.days, 19);
  assert.equal(elapsedPeriod(august, "2026-07-31"), null);
});

console.log("成本摊销");

const july = monthPeriod("2026-07-15");
const week = weekPeriod("2026-07-30"); // 07-27 ~ 08-02

check("一次性成本只落记账日所在周期", () => {
  const entry = {
    id: "a",
    name: "买号",
    amountRmb: 80,
    mode: "ONE_TIME",
    startDay: "2026-07-28",
    status: "active",
  };
  assert.equal(allocateCostEntry(entry, july)?.allocatedRmb, 80);
  assert.equal(allocateCostEntry(entry, week)?.allocatedRmb, 80);
  assert.equal(allocateCostEntry(entry, monthPeriod("2026-08-10")), null);
});

check("期间成本按天直线摊销", () => {
  // 7/1 ~ 7/31 共 31 天，310 元 → 每天 10 元
  const entry = {
    id: "b",
    name: "月订阅",
    amountRmb: 310,
    mode: "PERIOD",
    startDay: "2026-07-01",
    plannedEndDay: "2026-07-31",
    status: "active",
  };
  assert.equal(allocateCostEntry(entry, july)?.allocatedRmb, 310);
  // 本周只覆盖 7/27~7/31 共 5 天
  const inWeek = allocateCostEntry(entry, week);
  assert.equal(inWeek?.overlapDays, 5);
  assert.equal(inWeek?.allocatedRmb, 50);
});

check("当前月成本只摊到今天，不混入未来日期", () => {
  const elapsed = elapsedPeriod(monthPeriod("2026-08-15"), "2026-08-10");
  assert.ok(elapsed);
  const summary = summarizeCosts(
    [
      {
        id: "month-to-date",
        name: "月度订阅",
        amountRmb: 310,
        mode: "PERIOD",
        startDay: "2026-08-01",
        plannedEndDay: "2026-08-31",
        status: "active",
      },
    ],
    elapsed,
  );
  assert.equal(summary.totalRmb, 100);
});

check("跨月期间成本按重叠比例分摊", () => {
  // 7/16 ~ 8/15 共 31 天，620 元 → 每天 20 元；7 月占 16 天
  const entry = {
    id: "c",
    name: "跨月订阅",
    amountRmb: 620,
    mode: "PERIOD",
    startDay: "2026-07-16",
    plannedEndDay: "2026-08-15",
    status: "active",
  };
  assert.equal(allocateCostEntry(entry, july)?.allocatedRmb, 320);
  assert.equal(allocateCostEntry(entry, monthPeriod("2026-08-01"))?.allocatedRmb, 300);
  // 本周 7/27~8/02 全部落在有效期内，共 7 天 → 140
  assert.equal(allocateCostEntry(entry, week)?.overlapDays, 7);
  assert.equal(allocateCostEntry(entry, week)?.allocatedRmb, 140);
});

check("账号被风控提前结束：整笔压缩到实际存活区间", () => {
  // 原计划 7/1~7/31 摊 310 元（每天 10 元），7/5 被风控
  const entry = {
    id: "d",
    name: "被封的号",
    amountRmb: 310,
    mode: "PERIOD",
    startDay: "2026-07-01",
    plannedEndDay: "2026-07-31",
    actualEndDay: "2026-07-05",
    status: "ended",
  };
  const alloc = allocateCostEntry(entry, july);
  // 5 天摊完整笔，而不是只摊 50
  assert.equal(alloc?.allocatedRmb, 310);
  assert.equal(alloc?.effectiveDays, 5);
  assert.equal(alloc?.earlyEnded, true);
  // 7/1~7/5 那一周（6/29~7/5）也应拿到整笔
  assert.equal(allocateCostEntry(entry, weekPeriod("2026-07-01"))?.allocatedRmb, 310);
  // 结束之后的周期不再有成本
  assert.equal(allocateCostEntry(entry, week), null);
});

check("未定结束日按固定日额持续摊销（不会 30 天后消失）", () => {
  const entry = {
    id: "e",
    name: "进行中",
    amountRmb: 300,
    mode: "PERIOD",
    startDay: "2026-07-01",
    status: "active",
  };
  // 日额 = 300 / 30 = ¥10，分母是固定窗口，不随查询区间变
  const alloc = allocateCostEntry(entry, july);
  assert.equal(alloc?.openEnded, true);
  assert.equal(alloc?.effectiveDays, 30);
  assert.equal(alloc?.allocatedRmb, 310); // 7 月 31 天 × ¥10

  // 回归：开支还在继续，第二、三个月不该归零
  // （旧实现锚死在 startDay+29，第 31 天起 overlap=0 直接返回 null）
  const sep = monthPeriod("2026-09-15");
  const later = allocateCostEntry(entry, sep);
  assert.notEqual(later, null);
  assert.equal(later?.allocatedRmb, 300); // 9 月 30 天 × ¥10

  // 同一天在周报和月报里的日额必须一致
  const w = allocateCostEntry(entry, weekPeriod("2026-09-15"));
  assert.equal(w?.allocatedRmb, 70); // 7 天 × ¥10
});

check("作废的成本不入账", () => {
  assert.equal(
    allocateCostEntry(
      {
        id: "f",
        name: "填错了",
        amountRmb: 999,
        mode: "ONE_TIME",
        startDay: "2026-07-10",
        status: "void",
      },
      july,
    ),
    null,
  );
});

check("逐日摊销之和等于本期入账", () => {
  const summary = summarizeCosts(
    [
      {
        id: "g",
        name: "一次性",
        amountRmb: 80,
        mode: "ONE_TIME",
        startDay: "2026-07-28",
        status: "active",
      },
      {
        id: "h",
        name: "跨月",
        amountRmb: 140,
        mode: "PERIOD",
        startDay: "2026-07-27",
        plannedEndDay: "2026-08-02",
        status: "active",
      },
    ],
    week,
  );
  // 一次性 80 + 跨月 7 天 140 全落在本周 → 220
  assert.equal(summary.totalRmb, 220);
  const dayTotal = [...summary.byDay.values()].reduce((s, v) => s + v, 0);
  assert.equal(Math.round(dayTotal * 100) / 100, 220);
});

console.log("\n毛利公式");

check("计划里的固定样例：毛利 280、毛利率 28%", () => {
  const revenue = 1000; // 下游周消费
  const upstreamCost = 620; // 计费 Key 上游成本
  const costs = summarizeCosts(
    [
      {
        id: "i",
        name: "一次性账号",
        amountRmb: 80,
        mode: "ONE_TIME",
        startDay: "2026-07-28",
        status: "active",
      },
      {
        id: "j",
        name: "跨月订阅",
        // 7/16~7/31 共 16 天，64 元 → 每天 4 元；本周覆盖 7/27~7/31 共 5 天 = 20
        amountRmb: 64,
        mode: "PERIOD",
        startDay: "2026-07-16",
        plannedEndDay: "2026-07-31",
        status: "active",
      },
    ],
    week,
  );
  assert.equal(costs.totalRmb, 100); // 80 + 20
  const profit = revenue - upstreamCost - costs.totalRmb;
  assert.equal(profit, 280);
  assert.equal(Math.round((profit / revenue) * 1000) / 10, 28);
});

check("私域与公共池成本、毛利严格闭合", () => {
  const result = allocateOwnershipCosts({
    totalCostRmb: 56.66,
    privateRevenueRmb: 60,
    publicRevenueRmb: 40,
    privateModelCostRmb: 9.2,
    fallbackCostRmb: 36.66,
  });

  assert.equal(result.privateCostRmb + result.publicCostRmb, 56.66);
  assert.equal(60 - result.privateCostRmb, result.privateProfitRmb);
  assert.equal(40 - result.publicCostRmb, result.publicProfitRmb);
  assert.equal(
    result.privateProfitRmb + result.publicProfitRmb,
    result.measuredProfitRmb,
  );
});

check("没有公共池收入时不把成本错误分给公共池", () => {
  const result = allocateOwnershipCosts({
    totalCostRmb: 56.66,
    privateRevenueRmb: 24.5,
    publicRevenueRmb: 0,
    privateModelCostRmb: 1.09,
    fallbackCostRmb: 55.57,
  });

  assert.equal(result.privateCostRmb, 56.66);
  assert.equal(result.publicCostRmb, 0);
  assert.equal(result.publicProfitRmb, 0);
});

check("没有任何付费收入时不把全站成本误记为公共池应收", () => {
  const result = allocateOwnershipCosts({
    totalCostRmb: 30,
    privateRevenueRmb: 0,
    publicRevenueRmb: 0,
    privateModelCostRmb: 0,
    fallbackCostRmb: 30,
  });

  assert.equal(result.privateCostRmb, 30);
  assert.equal(result.publicCostRmb, 0);
  assert.equal(result.publicProfitRmb, 0);
});

check("全部公共池收入时成本就是需要收回的公共池成本", () => {
  const result = allocateOwnershipCosts({
    totalCostRmb: 30,
    privateRevenueRmb: 0,
    publicRevenueRmb: 50,
    privateModelCostRmb: 0,
    fallbackCostRmb: 30,
  });

  assert.equal(result.privateCostRmb, 0);
  assert.equal(result.publicCostRmb, 30);
  assert.equal(result.publicProfitRmb, 20);
});

console.log("\n预收款（按实际付款与到账时间）");

check("成功订单按私域/公共拆分，排除账号优先", () => {
  const ownership = new Map([
    [
      "site-a",
      {
        excludeUserIds: new Set([3, 4]),
        privateUserIds: new Set([1, 4]),
      },
    ],
  ]);
  const summary = summarizePrepaid(
    [
      {
        downstreamId: "site-a",
        userId: 1,
        moneyRmb: 80,
        status: "success",
        completedAt: new Date("2026-08-02T02:00:00Z"),
      },
      {
        downstreamId: "site-a",
        userId: 2,
        moneyRmb: 120,
        status: "success",
        completedAt: new Date("2026-08-03T02:00:00Z"),
      },
      {
        downstreamId: "site-a",
        userId: 3,
        moneyRmb: 999,
        status: "success",
        completedAt: new Date("2026-08-04T02:00:00Z"),
      },
      {
        downstreamId: "site-a",
        userId: 4,
        moneyRmb: 999,
        status: "success",
        completedAt: new Date("2026-08-04T02:00:00Z"),
      },
    ],
    ownership,
    {
      period: {
        start: new Date("2026-08-01T00:00:00+08:00"),
        end: new Date("2026-09-01T00:00:00+08:00"),
      },
      month: {
        start: new Date("2026-08-01T00:00:00+08:00"),
        end: new Date("2026-09-01T00:00:00+08:00"),
      },
    },
  );

  assert.deepEqual(summary.month, {
    privateRmb: 80,
    publicRmb: 120,
    totalRmb: 200,
    orders: 2,
  });
  assert.equal(summary.month.privateRmb + summary.month.publicRmb, summary.month.totalRmb);
});

check("只认成功订单的实际付款 money，并按完成时间入账", () => {
  const ownership = new Map([
    ["site-a", { excludeUserIds: new Set<number>(), privateUserIds: new Set([1]) }],
  ]);
  const summary = summarizePrepaid(
    [
      // 7 月下单、8 月到账，应计入 8 月；money=60 而充值额度可为 100
      {
        downstreamId: "site-a",
        userId: 1,
        moneyRmb: 60,
        status: "success",
        completedAt: new Date("2026-08-01T00:00:00+08:00"),
      },
      {
        downstreamId: "site-a",
        userId: 2,
        moneyRmb: 50,
        status: "pending",
        completedAt: new Date("2026-08-02T00:00:00+08:00"),
      },
      {
        downstreamId: "site-a",
        userId: 2,
        moneyRmb: 50,
        status: "failed",
        completedAt: new Date("2026-08-02T00:00:00+08:00"),
      },
      {
        downstreamId: "site-a",
        userId: 2,
        moneyRmb: 50,
        status: "success",
        completedAt: null,
      },
    ],
    ownership,
    {
      period: {
        start: new Date("2026-08-01T00:00:00+08:00"),
        end: new Date("2026-09-01T00:00:00+08:00"),
      },
      month: {
        start: new Date("2026-08-01T00:00:00+08:00"),
        end: new Date("2026-09-01T00:00:00+08:00"),
      },
    },
  );

  assert.equal(summary.month.totalRmb, 60);
  assert.equal(summary.month.orders, 1);
  assert.equal(summary.allTime.totalRmb, 60);
});

check("期初迁移冻结归属并只落在 2026-08-01", () => {
  const ownership = new Map([
    ["site-a", { excludeUserIds: new Set([1]), privateUserIds: new Set<number>() }],
  ]);
  const summary = summarizePrepaid(
    [
      {
        downstreamId: "site-a",
        userId: 1,
        moneyRmb: 80,
        status: "success",
        completedAt: new Date("2026-08-01T00:00:00+08:00"),
        ownership: "PRIVATE" as const,
        frozen: true,
      },
      {
        downstreamId: "site-a",
        userId: 2,
        moneyRmb: 120,
        status: "success",
        completedAt: new Date("2026-08-01T00:00:00+08:00"),
        ownership: "PUBLIC" as const,
        frozen: true,
      },
    ],
    ownership,
    {
      period: {
        start: new Date("2026-08-01T00:00:00+08:00"),
        end: new Date("2026-08-02T00:00:00+08:00"),
      },
      month: {
        start: new Date("2026-08-01T00:00:00+08:00"),
        end: new Date("2026-09-01T00:00:00+08:00"),
      },
    },
  );
  assert.deepEqual(summary.period, {
    privateRmb: 80,
    publicRmb: 120,
    totalRmb: 200,
    orders: 2,
  });
});

check("当前余额只认未消费 quota，不会叠加期初已发放额度", () => {
  const liability = summarizePrepaidLiability(
    [
      {
        downstreamId: "site-a",
        userId: 1,
        role: 1,
        quota: 25_000_000,
        quotaPerUnit: 500_000,
        observedAt: new Date("2026-08-11T00:00:00+08:00"),
      },
      {
        downstreamId: "site-a",
        userId: 2,
        role: 100,
        quota: 50_000_000,
        quotaPerUnit: 500_000,
        observedAt: new Date("2026-08-11T00:00:00+08:00"),
      },
    ],
    new Map([
      ["site-a", { excludeUserIds: new Set<number>(), privateUserIds: new Set([1]) }],
    ]),
  );
  assert.equal(liability.totalRmb, 50);
  assert.equal(liability.privateRmb, 50);
  assert.equal(liability.excludedRmb, 100);
  assert.equal(liability.users, 1);
});

console.log("\n预收款履约资金估算");

check("按近期成本率估算还需上游投入与预估收入", () => {
  // 近期：付费收入 100，全站消费 100，上游 40，额外 10
  // 上游成本率 0.4，额外 0.1
  // 当前预收 200，已有上游余额 30
  // 所需上游 80，还需投入 50；预估收入 200；预估毛利 100
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 200,
    privatePrepaidRmb: 120,
    publicPrepaidRmb: 80,
    balanceComplete: true,
    recent: {
      revenueRmb: 100,
      grossConsumptionRmb: 100,
      upstreamCostRmb: 40,
      upstreamCostAvailable: true,
      operatingCostRmb: 10,
    },
    upstreamBalanceRmb: 30,
  });
  assert.equal(plan.estimable, true);
  assert.equal(plan.balanceRmb, 200);
  assert.equal(plan.estimatedRevenueRmb, 200);
  assert.equal(plan.privateEstimatedRevenueRmb, 120);
  assert.equal(plan.publicEstimatedRevenueRmb, 80);
  assert.equal(plan.upstreamCostRate, 0.4);
  assert.equal(plan.operatingCostRate, 0.1);
  assert.equal(plan.requiredUpstreamCostRmb, 80);
  assert.equal(plan.requiredOperatingCostRmb, 20);
  assert.equal(plan.additionalUpstreamInvestRmb, 50);
  assert.equal(plan.estimatedProfitRmb, 100);
  assert.equal(plan.covered, false);
});

check("上游余额已覆盖时还需投入为 0", () => {
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: true,
    recent: {
      revenueRmb: 100,
      upstreamCostRmb: 40,
      upstreamCostAvailable: true,
      operatingCostRmb: 0,
    },
    upstreamBalanceRmb: 50,
  });
  assert.equal(plan.requiredUpstreamCostRmb, 40);
  assert.equal(plan.additionalUpstreamInvestRmb, 0);
  assert.equal(plan.covered, true);
  assert.equal(plan.estimatedProfitRmb, 60);
});

check("赠送剩余不计入预估收入，但仍计入所需上游", () => {
  // 余额 200（含赠送 50）→ 预估收入 150
  // 全站消费 120 / 上游 48 → 上游成本率 0.4 → 所需上游 200×0.4=80
  // 付费收入 100 / 额外 10 → 额外率 0.1 → 只摊付费收入 150×0.1=15
  // 已有上游 20 → 还需 60；预估毛利 150-80-15=55
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 200,
    privatePrepaidRmb: 120,
    publicPrepaidRmb: 80,
    bonusRemainingRmb: 50,
    privateBonusRemainingRmb: 30,
    publicBonusRemainingRmb: 20,
    balanceComplete: true,
    recent: {
      revenueRmb: 100,
      grossConsumptionRmb: 120,
      upstreamCostRmb: 48,
      upstreamCostAvailable: true,
      operatingCostRmb: 10,
    },
    upstreamBalanceRmb: 20,
  });
  assert.equal(plan.balanceRmb, 200);
  assert.equal(plan.bonusRemainingRmb, 50);
  assert.equal(plan.estimatedRevenueRmb, 150);
  assert.equal(plan.privateEstimatedRevenueRmb, 90);
  assert.equal(plan.publicEstimatedRevenueRmb, 60);
  assert.equal(plan.upstreamCostRate, 0.4);
  assert.equal(plan.requiredUpstreamCostRmb, 80);
  assert.equal(plan.requiredOperatingCostRmb, 15);
  assert.equal(plan.additionalUpstreamInvestRmb, 60);
  assert.equal(plan.estimatedProfitRmb, 55);
  assert.equal(plan.marginRate, 0.366667);
});

check("上游成本率优先用全站消费作分母", () => {
  // 付费收入 50，全站消费 100，上游 40 → 上游率 0.4（不是 0.8）
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: true,
    recent: {
      revenueRmb: 50,
      grossConsumptionRmb: 100,
      upstreamCostRmb: 40,
      upstreamCostAvailable: true,
      operatingCostRmb: 5,
    },
    upstreamBalanceRmb: 0,
  });
  assert.equal(plan.upstreamCostRate, 0.4);
  assert.equal(plan.operatingCostRate, 0.1);
  assert.equal(plan.requiredUpstreamCostRmb, 40);
  assert.equal(plan.requiredOperatingCostRmb, 10);
});

check("赠送剩余汇总排除测试号与管理员", () => {
  const userSnapshotBySite = new Map([
    ["site-a", new Map([
      [1, { role: 1, quota: 25_000_000 }],
      [2, { role: 1, quota: 10_000_000 }],
      [3, { role: 100, quota: 99_000_000 }],
      [4, { role: 1, quota: 5_000_000 }],
    ])],
  ]);
  const summary = summarizeBonusRemaining(
    [
      { downstreamId: "site-a", userId: 1, remainingQuota: 25_000_000 }, // 私域 50
      { downstreamId: "site-a", userId: 2, remainingQuota: 10_000_000 }, // 排除
      { downstreamId: "site-a", userId: 3, remainingQuota: 99_000_000 }, // admin
      { downstreamId: "site-a", userId: 4, remainingQuota: 5_000_000 }, // 公共 10
    ],
    new Map([
      [
        "site-a",
        {
          excludeUserIds: new Set([2]),
          privateUserIds: new Set([1]),
        },
      ],
    ]),
    {
      quotaPerUnitBySite: new Map([["site-a", 500_000]]),
      userSnapshotBySite,
      enabledSiteIds: new Set(["site-a"]),
    },
  );
  assert.equal(summary.privateRmb, 50);
  assert.equal(summary.publicRmb, 10);
  assert.equal(summary.totalRmb, 60);
});

check("赠送剩余只扣当前用户自己的余额，失效用户不会串扣", () => {
  const summary = summarizeBonusRemaining(
    [
      { downstreamId: "site-a", userId: 1, remainingQuota: 25_000_000 },
      { downstreamId: "site-a", userId: 9, remainingQuota: 99_000_000 },
    ],
    new Map([
      [
        "site-a",
        {
          excludeUserIds: new Set<number>(),
          privateUserIds: new Set([1]),
        },
      ],
    ]),
    {
      quotaPerUnitBySite: new Map([["site-a", 500_000]]),
      userSnapshotBySite: new Map([
        ["site-a", new Map([[1, { role: 1, quota: 5_000_000 }]])],
      ]),
    },
  );
  assert.equal(summary.privateRmb, 10);
  assert.equal(summary.publicRmb, 0);
  assert.equal(summary.totalRmb, 10);
});

check("管理员在赠送消费台账中统一归为排除账号", () => {
  const ownership = {
    excludeUserIds: new Set<number>(),
    privateUserIds: new Set([3]),
  };
  assert.equal(classifyPrepaidUser(3, 100, ownership), "EXCLUDED");
  assert.equal(classifyPrepaidUser(3, 1, ownership), "PRIVATE");
});

check("余额快照不完整或没有近期消费时不瞎估", () => {
  const incomplete = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: false,
    recent: {
      revenueRmb: 100,
      upstreamCostRmb: 40,
      upstreamCostAvailable: true,
    },
    upstreamBalanceRmb: 10,
  });
  assert.equal(incomplete.estimable, false);
  assert.equal(incomplete.additionalUpstreamInvestRmb, null);
  assert.ok(incomplete.reason);

  const noBurn = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: true,
    recent: {
      revenueRmb: 0,
      grossConsumptionRmb: 0,
      upstreamCostRmb: 0,
      upstreamCostAvailable: true,
    },
    upstreamBalanceRmb: 10,
  });
  assert.equal(noBurn.estimable, false);
  assert.equal(noBurn.estimatedRevenueRmb, 100);
  assert.equal(noBurn.additionalUpstreamInvestRmb, null);
});

check("成本数据缺失时不能用 0 成本伪装成无需投入", () => {
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: true,
    recent: {
      revenueRmb: 100,
      grossConsumptionRmb: 100,
      upstreamCostRmb: 0,
      upstreamCostAvailable: false,
    },
    upstreamBalanceRmb: 0,
  });
  assert.equal(plan.estimable, false);
  assert.equal(plan.requiredUpstreamCostRmb, null);
  assert.equal(plan.additionalUpstreamInvestRmb, null);
  assert.equal(plan.estimatedRevenueRmb, 100);
  assert.match(plan.reason || "", /成本数据未同步/);
});

check("成本率取较大消费分母并保留足够精度", () => {
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: true,
    recent: {
      revenueRmb: 100,
      grossConsumptionRmb: 80,
      upstreamCostRmb: 33.333,
      upstreamCostAvailable: true,
      operatingCostRmb: 0,
    },
    upstreamBalanceRmb: 0,
  });
  assert.equal(plan.upstreamCostRate, 0.3333);
  assert.equal(plan.requiredUpstreamCostRmb, 33.33);
});

check("只有赠送消费且存在额外成本时不伪造预估毛利", () => {
  const plan = estimatePrepaidFulfillment({
    prepaidRmb: 100,
    balanceComplete: true,
    recent: {
      revenueRmb: 0,
      grossConsumptionRmb: 100,
      upstreamCostRmb: 40,
      upstreamCostAvailable: true,
      operatingCostRmb: 10,
    },
    upstreamBalanceRmb: 0,
  });
  assert.equal(plan.estimable, true);
  assert.equal(plan.requiredUpstreamCostRmb, 40);
  assert.equal(plan.profitEstimable, false);
  assert.equal(plan.estimatedProfitRmb, null);
  assert.ok(plan.profitReason);
});

console.log("\n图表按日分桶（回归：时区错位会吞掉今天）");

check("最新一格恒为北京今天，且今天的数据不会丢", () => {
  const today = shanghaiDay();
  const series = buildDailySeries(
    [{ timestamp: today, costRmb: 999, deltaConsumed: 0 }],
    [{ timestamp: today, revenue: 555, revenueCurrency: "CNY" }],
    30,
  );
  assert.equal(series.length, 30);
  assert.equal(series[series.length - 1].date, today);

  const row = series.find((r) => r.date === today);
  assert.ok(row, "今天必须有对应的桶");
  assert.equal(row.costRmb, 999);
  assert.equal(row.revenueRmb, 555);

  // 一分钱都不能在分桶时掉出窗口
  assert.equal(series.reduce((s, r) => s + r.costRmb, 0), 999);
  assert.equal(series.reduce((s, r) => s + r.revenueRmb, 0), 555);
});

check("Date 与日字符串两种输入落到同一个桶", () => {
  const today = shanghaiDay();
  const viaString = buildDailySeries(
    [{ timestamp: today, costRmb: 10, deltaConsumed: 0 }],
    [],
    7,
  );
  const viaDate = buildDailySeries(
    [{ timestamp: new Date(), costRmb: 10, deltaConsumed: 0 }],
    [],
    7,
  );
  assert.equal(
    viaString.find((r) => r.date === today)?.costRmb,
    viaDate.find((r) => r.date === today)?.costRmb,
  );
});

console.log("\n凭据加解密（回归：解密失败不能返回密文）");

check("正常往返", () => {
  process.env.ENCRYPTION_SECRET = "unit-test-secret";
  const plain = "sk-abc123";
  assert.equal(decryptSecret(encryptSecret(plain)), plain);
});

check("历史明文原样返回（含冒号的也不能当密文解析）", () => {
  process.env.ENCRYPTION_SECRET = "unit-test-secret";
  assert.equal(decryptSecret("rawkey"), "rawkey");
  assert.equal(
    decryptSecret("https://user:pass@host/p"),
    "https://user:pass@host/p",
  );
  assert.equal(decryptSecret(""), "");
});

check("密钥轮换后解密失败返回空串，而不是把密文当 Key 用", () => {
  process.env.ENCRYPTION_SECRET = "unit-test-secret";
  const bundle = encryptSecret("sk-abc123");
  process.env.ENCRYPTION_SECRET = "rotated-secret";
  // 解密失败会打一行 console.error，这里是预期路径，别污染自检输出
  const realError = console.error;
  console.error = () => {};
  let out: string;
  try {
    out = decryptSecret(bundle);
  } finally {
    console.error = realError;
  }
  // 返回密文会让调用方的 `if (!raw) throw 缺少 Key` 守卫全部失效，
  // 然后把密文当凭据发给第三方站点
  assert.equal(out, "");
  assert.notEqual(out, bundle);
});

console.log("\n会话签名（回归：改密码必须踢掉旧会话）");

await checkAsync("node 与 edge 两条实现算出同一个签名", async () => {
  process.env.AUTH_SECRET = "unit-secret";
  process.env.AUTH_USERNAME = "admin";
  process.env.AUTH_PASSWORD = "pw-original";
  const token = createSessionToken("admin");
  // 两边不一致会导致「登录成功但中间件一直判未登录」，即登录页死循环
  assert.equal(verifySessionToken(token)?.u, "admin");
  assert.equal((await verifySessionTokenEdge(token))?.u, "admin");
});

await checkAsync("改密码后旧 token 在两条实现里都失效", async () => {
  process.env.AUTH_SECRET = "unit-secret";
  process.env.AUTH_USERNAME = "admin";
  process.env.AUTH_PASSWORD = "pw-original";
  const token = createSessionToken("admin");

  process.env.AUTH_PASSWORD = "pw-rotated";
  assert.equal(verifySessionToken(token), null);
  assert.equal(await verifySessionTokenEdge(token), null);

  // 改用户名同样要失效
  process.env.AUTH_PASSWORD = "pw-original";
  process.env.AUTH_USERNAME = "other";
  assert.equal(verifySessionToken(token), null);

  // 凭据还原后应重新可用 —— 证明是确定性派生而非随机密钥
  process.env.AUTH_USERNAME = "admin";
  assert.equal(verifySessionToken(token)?.u, "admin");
});

console.log("\n登录限流");

check("超过免罚次数后锁定，其它来源不受影响", () => {
  __resetRateLimit();
  for (let i = 0; i < RL.FREE_ATTEMPTS; i++) {
    assert.equal(checkLoginAllowed("1.1.1.1").allowed, true);
    recordLoginFailure("1.1.1.1");
  }
  recordLoginFailure("1.1.1.1");
  const v = checkLoginAllowed("1.1.1.1");
  assert.equal(v.allowed, false);
  assert.equal(v.scope, "ip");
  assert.ok(v.retryAfterSec > 0);
  assert.equal(checkLoginAllowed("2.2.2.2").allowed, true);
});

check("登录成功后清零失败计数", () => {
  __resetRateLimit();
  for (let i = 0; i < RL.FREE_ATTEMPTS + 2; i++) recordLoginFailure("3.3.3.3");
  assert.equal(checkLoginAllowed("3.3.3.3").allowed, false);
  recordLoginSuccess("3.3.3.3");
  assert.equal(checkLoginAllowed("3.3.3.3").allowed, true);
});

check("伪造 X-Forwarded-For 轮换 IP 仍会被全局限流拦下", () => {
  // 转发头可以随便写，只按 IP 限流等于没限 —— 全局这层才是真正的兜底
  __resetRateLimit();
  let blocked = false;
  for (let i = 0; i < RL.GLOBAL_MAX_FAILURES + 5; i++) {
    const fakeIp = `10.0.${Math.floor(i / 256)}.${i % 256}`;
    if (!checkLoginAllowed(fakeIp).allowed) {
      blocked = true;
      break;
    }
    recordLoginFailure(fakeIp);
  }
  assert.ok(blocked, "轮换伪造 IP 绕过了限流");
  assert.equal(checkLoginAllowed("9.9.9.9").scope, "global");
});

console.log("\n扩展 token 有效期");

check("过期与禁用都判为不可用，老 token（null）仍可用", () => {
  const now = new Date("2026-07-31T00:00:00Z");
  // token 会出现在 URL 里（进访问日志），过期判定是最后一道闸
  assert.equal(isTokenExpired({ expiresAt: null }, now), false);
  assert.equal(
    isTokenExpired({ expiresAt: new Date("2026-08-30T00:00:00Z") }, now),
    false,
  );
  assert.equal(
    isTokenExpired({ expiresAt: new Date("2026-07-30T23:59:59Z") }, now),
    true,
  );
  // 边界：到期时刻本身算过期
  assert.equal(isTokenExpired({ expiresAt: now }, now), true);
});

check("新建 token 默认带期限，显式传 null 才永久", () => {
  const now = new Date("2026-07-31T00:00:00Z");
  const def = resolveExpiry(undefined, now);
  assert.ok(def, "默认必须有期限，否则泄露的 token 永久可用");
  assert.equal(
    Math.round((def.getTime() - now.getTime()) / 86_400_000),
    DEFAULT_TOKEN_TTL_DAYS,
  );
  assert.equal(resolveExpiry(null, now), null);
  assert.equal(resolveExpiry(0, now), null);
  // 上限收口，避免传个 99999 天等于永久
  const huge = resolveExpiry(99_999, now)!;
  assert.equal(
    Math.round((huge.getTime() - now.getTime()) / 86_400_000),
    MAX_TOKEN_TTL_DAYS,
  );
});

console.log("\n赠送兑换码签发限制");

check("单码与单批面值上限在服务端生效", () => {
  validateGiftIssuanceValue({ quota: 1_000 * 500_000, count: 5, quotaPerUnit: 500_000 });
  assert.throws(
    () => validateGiftIssuanceValue({ quota: 1_001 * 500_000, count: 1, quotaPerUnit: 500_000 }),
    /单个赠送码不能超过/,
  );
  assert.throws(
    () => validateGiftIssuanceValue({ quota: 501 * 500_000, count: 10, quotaPerUnit: 500_000 }),
    /单批赠送总额不能超过/,
  );
});

check("签发频率达到窗口上限后返回重试时间", () => {
  __resetGiftIssuanceLimit();
  const now = 1_000_000;
  for (let i = 0; i < GIFT_ISSUANCE_LIMITS.MAX_REQUESTS_PER_WINDOW; i++) {
    assert.equal(checkGiftIssuanceAllowed(now).allowed, true);
    recordGiftIssuance(now);
  }
  const blocked = checkGiftIssuanceAllowed(now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, GIFT_ISSUANCE_LIMITS.WINDOW_MS / 1000);
  assert.equal(checkGiftIssuanceAllowed(now + GIFT_ISSUANCE_LIMITS.WINDOW_MS).allowed, true);
  __resetGiftIssuanceLimit();
});


console.log("\n自动同步护栏");

check("间隔下限与上限在归一化时收口", () => {
  // 界面能填任何数，硬校验在服务端。比下限更密只会给上游加压。
  assert.equal(normalizeAutoSyncConfig({ intervalMinutes: 1 }).intervalMinutes, AS.MIN_INTERVAL_MINUTES);
  assert.equal(normalizeAutoSyncConfig({ intervalMinutes: 0 }).intervalMinutes, AS.MIN_INTERVAL_MINUTES);
  assert.equal(normalizeAutoSyncConfig({ intervalMinutes: 99_999 }).intervalMinutes, AS.MAX_INTERVAL_MINUTES);
  assert.equal(normalizeAutoSyncConfig({ intervalMinutes: 30 }).intervalMinutes, 30);
  // 默认必须是关闭：升级镜像不该让容器自己开始定时打上游
  assert.equal(normalizeAutoSyncConfig({}).enabled, false);
  assert.equal(normalizeAutoSyncConfig({ enabled: "yes" }).enabled, false);
  assert.equal(normalizeAutoSyncConfig({ scope: "bogus" }).scope, "all");
});

check("下一轮时刻带抖动，且抖动幅度对称", () => {
  const now = 1_000_000;
  const base = 60 * 60 * 1000;
  // 抖动是为了不贴整点、重启后不踩同一时刻
  assert.equal(nextRunAt(60, now, 0) - now, Math.round(base * (1 - AS.JITTER_RATIO)));
  assert.equal(nextRunAt(60, now, 1) - now, Math.round(base * (1 + AS.JITTER_RATIO)));
  // 时间戳必须是整数：小数会一路带进 new Date().toISOString()
  assert.ok(Number.isInteger(nextRunAt(60, now, 0.37)));
  assert.equal(nextRunAt(60, now, 0.5) - now, base);
  // 即使传了小于下限的间隔，也按下限算
  assert.ok(nextRunAt(1, now, 0.5) - now >= AS.MIN_INTERVAL_MINUTES * 60 * 1000 * 0.9);
});

check("错误按是否会自愈分类", () => {
  // 凭据类不会自愈，重试只是白打对方的登录接口
  assert.equal(classifyFailure("Sub2API 自动登录失败，请检查邮箱/密码"), "credential");
  assert.equal(classifyFailure("API Key 无效或无权查询用量"), "credential");
  assert.equal(classifyFailure("HTTP 401 unauthorized"), "credential");
  assert.equal(classifyFailure("缺少 Admin API Key，请到「自建上游」补填"), "credential");
  // 限流类：对方已经明说太快了
  assert.equal(classifyFailure("上游请求过于频繁，请稍后重试"), "rate-limit");
  assert.equal(classifyFailure("上游用量查询失败 (HTTP 429)"), "rate-limit");
  assert.equal(classifyFailure("Rate limit exceeded"), "rate-limit");
  // 其余按网络类，指数退避后还会再试
  assert.equal(classifyFailure("无法连接上游用量接口"), "network");
  assert.equal(classifyFailure("Request timeout"), "network");
  assert.equal(classifyFailure(undefined), "network");
});

check("退避随连续失败递增并收在上限", () => {
  assert.equal(backoffMs(1, "network"), AS.BACKOFF_BASE_MS);
  assert.equal(backoffMs(2, "network"), AS.BACKOFF_BASE_MS * 2);
  assert.equal(backoffMs(3, "network"), AS.BACKOFF_BASE_MS * 4);
  assert.equal(backoffMs(99, "network"), AS.BACKOFF_MAX_MS);
  // 限流类起步就 ×4
  assert.equal(backoffMs(1, "rate-limit"), AS.BACKOFF_BASE_MS * AS.RATE_LIMIT_MULTIPLIER);
  // 凭据类直接顶到上限：等人去改密码，别每小时撞一次
  assert.equal(backoffMs(1, "credential"), AS.BACKOFF_MAX_MS);
  // 任何组合都不会超过上限
  for (const cls of ["network", "rate-limit", "credential"] as const) {
    for (let n = 1; n < 40; n++) assert.ok(backoffMs(n, cls) <= AS.BACKOFF_MAX_MS);
  }
});

check("退避中的目标被自动同步跳过，到点后恢复", () => {
  const now = 2_000_000;
  const targets = [
    { kind: "upstream" as const, id: "a", name: "A" },
    { kind: "upstream" as const, id: "b", name: "B" },
    { kind: "downstream" as const, id: "c", name: "C" },
  ];
  const map: BackoffMap = {
    "upstream:b": {
      failures: 3,
      nextAt: new Date(now + 60_000).toISOString(),
      lastAt: new Date(now).toISOString(),
      lastError: "登录失败",
      failureClass: "credential",
      name: "B",
    },
  };
  const first = selectDueTargets(targets, map, now);
  assert.deepEqual(first.due.map((t) => t.id), ["a", "c"]);
  assert.deepEqual(first.skipped.map((s) => s.target.id), ["b"]);
  // 退避到点后重新纳入
  const later = selectDueTargets(targets, map, now + 61_000);
  assert.deepEqual(later.due.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(later.skipped.length, 0);
  // 空退避表时全部都跑
  assert.equal(selectDueTargets(targets, {}, now).due.length, 3);
});

console.log("\n同步任务状态");

const syncJobFixture = (patch: Partial<SyncJob>): SyncJob => ({
  runId: "r1",
  trigger: "manual",
  scope: "全部",
  state: "running",
  total: 9,
  done: 3,
  ok: 3,
  fail: 0,
  startedAt: new Date(0).toISOString(),
  heartbeatAt: new Date(0).toISOString(),
  results: [],
  ...patch,
});

check("心跳停摆的任务读成已中断，而不是永远显示同步中", () => {
  const now = Date.now();
  // 心跳还新鲜：照常是 running
  const live = __withStaleCheck(
    syncJobFixture({ heartbeatAt: new Date(now - 1_000).toISOString() }),
  );
  assert.equal(live!.state, "running");
  // 心跳超过阈值：容器大概被重启了，不能骗用户说还在跑
  const dead = __withStaleCheck(
    syncJobFixture({
      heartbeatAt: new Date(now - SJ.HEARTBEAT_STALE_MS - 1_000).toISOString(),
    }),
  );
  assert.equal(dead!.state, "interrupted");
  assert.equal(dead!.current, undefined);
  assert.match(dead!.error!, /中断/);
  // 已结束的任务不受心跳判定影响
  const done = __withStaleCheck(
    syncJobFixture({
      state: "success",
      heartbeatAt: new Date(now - 86_400_000).toISOString(),
    }),
  );
  assert.equal(done!.state, "success");
  assert.equal(__withStaleCheck(null), null);
});


console.log("\n出网节流闸门");

await checkAsync("同一主机的请求串行，不同主机可以并发", async () => {
  __resetHostGate();
  const order: string[] = [];
  const one = (tag: string, ms: number) =>
    withHostGate("https://a.example/x", async () => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    });
  // 故意让第一个最慢：串行的话它必须先跑完
  await Promise.all([one("A", 60), one("B", 10), one("C", 10)]);
  assert.deepEqual(order, [
    "A:start", "A:end", "B:start", "B:end", "C:start", "C:end",
  ]);

  // 不同主机之间不该互相等：那样一个慢站会拖垮整轮同步
  __resetHostGate();
  const started = Date.now();
  await Promise.all([
    withHostGate("https://b1.example/", () => new Promise((r) => setTimeout(r, 200))),
    withHostGate("https://b2.example/", () => new Promise((r) => setTimeout(r, 200))),
  ]);
  assert.ok(Date.now() - started < 400, "不同主机应当并发");
});

await checkAsync("抛异常不会把该主机的队列永久卡死", async () => {
  __resetHostGate();
  await withHostGate("https://c.example/", async () => {
    throw new Error("boom");
  }).catch(() => undefined);
  // 上一条炸了，后面的还得能跑 —— 否则一次超时就要重启容器
  assert.equal(await withHostGate("https://c.example/", async () => "alive"), "alive");
});

check("限流退避优先按 Retry-After，并收在上限内", () => {
  __resetHostGate();
  assert.equal(noteRateLimited("d.example", "5"), 5_000);
  // 对方给个离谱的值也不能真等那么久
  assert.equal(noteRateLimited("d.example", "99999"), HG.MAX_COOLDOWN_MS);
  // 没给 Retry-After 时按指数退避
  assert.equal(noteRateLimited("d.example", null, 0), HG.RATE_LIMIT_COOLDOWN_MS);
  assert.equal(noteRateLimited("d.example", null, 2), HG.RATE_LIMIT_COOLDOWN_MS * 4);
  assert.equal(noteRateLimited("d.example", null, 99), HG.MAX_COOLDOWN_MS);
});

check("限流命中对调度器可见，用于整轮延后", () => {
  __resetHostGate();
  const before = Date.now() - 1;
  assert.equal(sawRateLimitSince(before), false);
  noteRateLimited("e.example", "1");
  assert.equal(sawRateLimitSince(before), true);
  // 只看命中之后的时间窗：更晚的起点不该被算进去
  assert.equal(sawRateLimitSince(Date.now() + 10_000), false);
});


console.log("\n非 JSON 响应兜底（回归：网关 HTML 超时页）");

await checkAsync("反代返回 HTML 超时页时给出可读报错，而不是 Unexpected token", async () => {
  const html =
    '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head>' +
    "<body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>";

  // 无条件 res.json() 时用户看到的就是这一句，完全看不出发生了什么
  await assert.rejects(
    () => new Response(html, { status: 504 }).json(),
    /is not valid JSON/,
  );

  // 换成 readJson：说清是网关超时，并提示服务端可能还在跑
  const gateway = new Response(html, {
    status: 504,
    headers: { "content-type": "text/html" },
  });
  await assert.rejects(readJson(gateway), (error: Error) => {
    assert.match(error.message, /网关返回了非 JSON 响应（HTTP 504）/);
    assert.match(error.message, /仍在后台处理/);
    assert.doesNotMatch(error.message, /Unexpected token/);
    return true;
  });

  // Cloudflare 的 524 归到同一类
  await assert.rejects(
    readJson(new Response(html, { status: 524, headers: { "content-type": "text/html" } })),
    /HTTP 524/,
  );

  // 正常 JSON 不受影响
  assert.deepEqual(
    await readJson(
      new Response(JSON.stringify({ data: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
    { data: 1 },
  );

  // 纯文本错误按原文透出，别再包一层看不懂的话
  await assert.rejects(
    readJson(
      new Response("upstream connect error", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    ),
    /upstream connect error（HTTP 502）/,
  );
});

check("同步结果汇总与进度文案", () => {
  const base = {
    runId: "r",
    trigger: "manual" as const,
    scope: "全部",
    state: "success" as const,
    total: 9,
    done: 9,
    ok: 8,
    fail: 1,
    startedAt: "",
    heartbeatAt: "",
    results: [],
  };
  assert.deepEqual(summarizeSyncJob(base), {
    text: "同步完成：8 成功 / 1 失败",
    tone: "error",
  });
  assert.deepEqual(summarizeSyncJob({ ...base, ok: 9, fail: 0 }), {
    text: "同步完成：9 成功 / 0 失败",
    tone: "success",
  });
  // 中断要说出来，不能显示成「同步完成」
  assert.equal(
    summarizeSyncJob({ ...base, state: "interrupted", error: "同步进程中断" }).tone,
    "error",
  );
  assert.equal(syncProgressLabel({ ...base, done: 3 }), "同步中 3/9");
  assert.equal(syncProgressLabel(null), "同步中…");
});


console.log("\n上游累计消费基线（回归：2026-08-20 的 ¥39.50 幻影成本）");

check("读不到累计消费时保留原基线并计 0 增量", () => {
  // 这是幻影成本的第一步：stats 接口失败，consumed 停在 0 却照常算成功
  const kept = resolveConsumedBaseline({
    reported: 0,
    reportedUnknown: true,
    previous: 37.9413677575,
    isFirstSync: false,
  });
  assert.equal(kept.baseline, 37.9413677575, "基线不能被 0 覆盖");
  assert.equal(kept.delta, 0);
  assert.equal(kept.unknown, true);

  // 还没有基线时也不会凭空造出一个
  assert.deepEqual(
    resolveConsumedBaseline({ reported: 0, reportedUnknown: true, previous: null, isFirstSync: true }),
    { baseline: 0, delta: 0, unknown: true },
  );
});

check("正常读数照常推进基线；首次同步不把历史累计计成本", () => {
  const grew = resolveConsumedBaseline({ reported: 38.5, previous: 37.9, isFirstSync: false });
  assert.equal(grew.baseline, 38.5);
  assert.ok(Math.abs(grew.delta - 0.6) < 1e-9);

  // 首次只建基线
  assert.deepEqual(
    resolveConsumedBaseline({ reported: 37.94, previous: null, isFirstSync: true }),
    { baseline: 37.94, delta: 0, unknown: false },
  );

  // 上游自己重置了计数：增量不能是负数
  assert.equal(
    resolveConsumedBaseline({ reported: 5, previous: 37.94, isFirstSync: false }).delta,
    0,
  );
});

check("整号回退遇到被清零的基线时放弃记账", () => {
  // 幻影成本的第二步：基线是 0，读回 37.94，差额恰好等于全部历史累计
  const reset = shouldSkipAccountFallback({
    delta: 37.9413677575,
    reported: 37.9413677575,
    previous: 0,
    consumedUnknown: false,
  });
  assert.equal(reset.skip, true);
  assert.equal(reset.reason, "baseline-reset");

  // 本轮没读到累计消费，同样不能拿它当成本
  const unknown = shouldSkipAccountFallback({
    delta: 0,
    reported: 0,
    previous: 37.94,
    consumedUnknown: true,
  });
  assert.equal(unknown.skip, true);
  assert.equal(unknown.reason, "unknown-reading");
});

check("正常的整号增量仍然照记，不被守卫误伤", () => {
  // 真实增长：基线非 0，增量远小于累计
  const normal = shouldSkipAccountFallback({
    delta: 0.6,
    reported: 38.5,
    previous: 37.9,
    consumedUnknown: false,
  });
  assert.equal(normal.skip, false);
  assert.equal(normal.reason, null);

  // 第一次同步（基线 0、增量 0）不该被当成基线重置
  assert.equal(
    shouldSkipAccountFallback({ delta: 0, reported: 37.94, previous: 0, consumedUnknown: false }).skip,
    false,
  );

  // 基线本来就是 0 且真的只花了这么多（增量=累计）会被保守跳过，
  // 代价是成本偏低而不是虚增 —— 这是刻意的取舍
  assert.equal(
    shouldSkipAccountFallback({ delta: 1.5, reported: 1.5, previous: 0, consumedUnknown: false }).reason,
    "baseline-reset",
  );
});

console.log(`\n全部通过：${passed} 项`);
