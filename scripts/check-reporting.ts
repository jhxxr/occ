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

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
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

check("未定结束日按滚动窗口估算", () => {
  const entry = {
    id: "e",
    name: "进行中",
    amountRmb: 300,
    mode: "PERIOD",
    startDay: "2026-07-01",
    status: "active",
  };
  const alloc = allocateCostEntry(entry, july);
  assert.equal(alloc?.openEnded, true);
  assert.equal(alloc?.effectiveDays, 30);
  assert.equal(alloc?.allocatedRmb, 300);
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

console.log(`\n全部通过：${passed} 项`);
