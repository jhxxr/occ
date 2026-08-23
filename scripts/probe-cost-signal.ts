/**
 * 只读探测：Orbit 侧到底有没有可用来排序的「成本差异」。
 *
 * 按成本排优先级的前提是各上游成本**不一样**。这个脚本检查三个成本口径：
 *   A. UpstreamProvider.discountRate  配置值（¥ / 每 1 面值）
 *   B. UpstreamRechargeLog            实付/到账反推的真实购入单价
 *   C. UpstreamUsageDaily.costRateRmb 历史入账时写死的成本率
 *
 * 若三者都无差异，则「按成本排序」无数据可排 —— 这是必须先确认的事实。
 */

import "dotenv/config";
import { prisma } from "../src/lib/db.ts";

function line(c = "─", n = 68) {
  return c.repeat(n);
}

console.log(`\n${line("═")}\nA. UpstreamProvider.discountRate（配置成本率）\n${line("═")}`);

const providers = await prisma.upstreamProvider.findMany({
  orderBy: { createdAt: "asc" },
  select: {
    id: true,
    name: true,
    baseUrl: true,
    type: true,
    enabled: true,
    retiredAt: true,
    discountRate: true,
    quotaPerDollar: true,
    currency: true,
  },
});

console.log("  上游名            类型         启用  discountRate  quotaPerDollar");
console.log(`  ${line("─", 66)}`);
for (const p of providers) {
  console.log(
    `  ${p.name.slice(0, 16).padEnd(17)} ${p.type.padEnd(12)} ` +
      `${p.retiredAt ? "弃用" : p.enabled ? "是  " : "停用"}  ` +
      `${String(p.discountRate).padEnd(13)} ${p.quotaPerDollar}`,
  );
}

const active = providers.filter((p) => !p.retiredAt);
const rates = [...new Set(active.map((p) => p.discountRate))];
console.log(
  `\n  在用上游 ${active.length} 个，discountRate 去重后 ${rates.length} 种：${rates.join(", ")}`,
);
if (rates.length <= 1) {
  console.log("  ⚠ 所有在用上游成本率完全相同 → 按 discountRate 排序等于不排序");
} else {
  console.log("  ✓ 存在成本差异，可作排序依据");
}

console.log(`\n${line("═")}\nB. UpstreamRechargeLog（实付/到账 → 真实购入单价）\n${line("═")}`);

const recharges = await prisma.upstreamRechargeLog.groupBy({
  by: ["providerId", "status"],
  _sum: { paidRmb: true, creditGained: true },
  _count: true,
});

if (recharges.length === 0) {
  console.log("  （无充值记录）→ 无法反推真实购入成本");
} else {
  const nameOf = new Map(providers.map((p) => [p.id, p.name]));
  console.log("  上游名            状态       笔数  实付¥      到账面值    实际单价");
  console.log(`  ${line("─", 68)}`);
  for (const r of recharges) {
    const paid = r._sum.paidRmb || 0;
    const credit = r._sum.creditGained || 0;
    const eff = credit > 0 ? (paid / credit).toFixed(4) : "—";
    console.log(
      `  ${(nameOf.get(r.providerId) || r.providerId).slice(0, 16).padEnd(17)} ` +
        `${r.status.padEnd(10)} ${String(r._count).padEnd(5)} ` +
        `${paid.toFixed(2).padEnd(10)} ${credit.toFixed(2).padEnd(11)} ${eff}`,
    );
  }
}

console.log(`\n${line("═")}\nC. UpstreamUsageDaily.costRateRmb（历史写死成本率）\n${line("═")}`);

const daily = await prisma.upstreamUsageDaily.groupBy({
  by: ["providerId", "costRateSource"],
  _min: { costRateRmb: true },
  _max: { costRateRmb: true },
  _count: true,
});

if (daily.length === 0) {
  console.log("  （无按日用量记录）");
} else {
  const nameOf = new Map(providers.map((p) => [p.id, p.name]));
  console.log("  上游名            来源      行数   costRateRmb 范围");
  console.log(`  ${line("─", 60)}`);
  for (const d of daily) {
    console.log(
      `  ${(nameOf.get(d.providerId) || d.providerId).slice(0, 16).padEnd(17)} ` +
        `${d.costRateSource.padEnd(9)} ${String(d._count).padEnd(6)} ` +
        `${d._min.costRateRmb} ~ ${d._max.costRateRmb}`,
    );
  }
}

console.log(`\n${line("═")}\nD. 下游按渠道消费（DownstreamChannelDay，反推口径的原料）\n${line("═")}`);

const chDays = await prisma.downstreamChannelDay.aggregate({
  _count: true,
  _min: { day: true },
  _max: { day: true },
});
console.log(
  `  ${chDays._count} 行，覆盖 ${chDays._min.day || "—"} ~ ${chDays._max.day || "—"}`,
);

const orphans = await prisma.downstreamOrphanChannel.findMany({
  select: {
    channelId: true,
    channelName: true,
    costMode: true,
    costRate: true,
    costAmountRmb: true,
    resolved: true,
  },
  orderBy: { channelId: "asc" },
});
console.log(`\n  已手工补录成本的旧渠道 ${orphans.length} 条：`);
for (const o of orphans) {
  console.log(
    `    ch#${String(o.channelId).padEnd(4)} ${(o.channelName || "(无名)").slice(0, 18).padEnd(19)} ` +
      `${o.costMode}  rate=${o.costRate ?? "—"}  amount=${o.costAmountRmb ?? "—"}  ` +
      `${o.resolved ? "已确认" : "未确认"}`,
  );
}

console.log(`\n${line("═")}\n探测完成（只读）\n${line("═")}\n`);

await prisma.$disconnect();
