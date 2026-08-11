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
  isTokenExpired,
  resolveExpiry,
  DEFAULT_TOKEN_TTL_DAYS,
  MAX_TOKEN_TTL_DAYS,
} from "../src/lib/extension-token.ts";
import { allocateOwnershipCosts } from "../src/lib/cost-allocation.ts";
import { summarizePrepaid, summarizePrepaidLiability } from "../src/lib/prepaid.ts";
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

console.log(`\n全部通过：${passed} 项`);