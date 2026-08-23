/**
 * 只读探测：能否用 key 指纹把 NewAPI channel 对上 Orbit 已知的上游 Key，
 * 从而拿到该渠道的真实采购倍率（rateMultiplier）。
 *
 * UpstreamApiKey.keyPreview 的格式是 `first6…last4`（见 sub2/sync-keys.ts:125），
 * NewAPI channels.key 存的是同一把 Key。两边算同样的指纹即可对上。
 *
 * 安全：channels.key 只在内存里参与指纹计算，**从不打印、从不落盘**。
 * 输出只有渠道 id / 名称 / 分组 / 匹配到的上游与倍率。
 */

import "dotenv/config";
import type { RowDataPacket } from "mysql2";
import { prisma } from "../src/lib/db.ts";
import { decryptSecret } from "../src/lib/crypto.ts";
import { withNewApiDb } from "../src/lib/newapi-db.ts";

function line(c = "─", n = 76) {
  return c.repeat(n);
}

/** 与 sub2/sync-keys.ts 完全一致的指纹算法 */
function preview(key: string): string {
  return key ? `${key.slice(0, 6)}…${key.slice(-4)}` : "";
}

const site = await prisma.downstreamSite.findFirst({
  where: { dbDsn: { not: null } },
  select: { id: true, name: true, dbDsn: true, quotaPerDollar: true },
});
if (!site?.dbDsn) {
  console.log("没有已绑定 DSN 的下游站点");
  await prisma.$disconnect();
  process.exit(0);
}

const plain = decryptSecret(site.dbDsn);
if (!plain) {
  console.log("DSN 无法解密");
  await prisma.$disconnect();
  process.exit(1);
}

// Orbit 已知的 Key 指纹 → 上游 + 倍率
const apiKeys = await prisma.upstreamApiKey.findMany({
  select: {
    keyPreview: true,
    groupName: true,
    name: true,
    rateMultiplier: true,
    countAsCost: true,
    provider: { select: { name: true, discountRate: true } },
  },
});
const boundKeys = await prisma.upstreamBoundKey.findMany({
  where: { removedAt: null },
  select: {
    keyPreview: true,
    name: true,
    countAsCost: true,
    provider: { select: { name: true, discountRate: true } },
  },
});

const byPreview = new Map<
  string,
  {
    provider: string;
    label: string;
    rate: number | null;
    countAsCost: boolean;
    kind: string;
  }
>();
for (const k of apiKeys) {
  if (!k.keyPreview) continue;
  byPreview.set(k.keyPreview, {
    provider: k.provider.name,
    label: k.groupName || k.name || "",
    rate: k.rateMultiplier,
    countAsCost: k.countAsCost,
    kind: "ApiKey",
  });
}
for (const k of boundKeys) {
  if (!k.keyPreview || byPreview.has(k.keyPreview)) continue;
  byPreview.set(k.keyPreview, {
    provider: k.provider.name,
    label: k.name || "",
    rate: null,
    countAsCost: k.countAsCost,
    kind: "BoundKey",
  });
}

console.log(
  `\nOrbit 已知 Key 指纹 ${byPreview.size} 个（ApiKey ${apiKeys.length} + BoundKey ${boundKeys.length}）`,
);

const rows = await withNewApiDb(plain, async (conn) => {
  const [r] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, `group`, `key`, status, priority, weight FROM channels ORDER BY id ASC",
  );
  return (r || []) as RowDataPacket[];
});

console.log(`NewAPI 渠道 ${rows.length} 个\n`);
console.log(`${line("═")}`);
console.log("  ch   分组            渠道名              → 上游 / 分组            倍率  计成本");
console.log(`${line("═")}`);

let matched = 0;
let withRate = 0;
const rateValues: number[] = [];

for (const r of rows) {
  // key 只在这里参与指纹计算，绝不输出
  const fp = preview(String(r.key || ""));
  const hit = byPreview.get(fp);
  if (hit) {
    matched++;
    if (hit.rate != null) {
      withRate++;
      rateValues.push(hit.rate);
    }
  }
  const chName = String(r.name || "").slice(0, 18).padEnd(19);
  const grp = String(r.group || "-").slice(0, 14).padEnd(15);
  if (hit) {
    console.log(
      `  ${String(r.id).padEnd(4)} ${grp} ${chName} → ${`${hit.provider}/${hit.label}`.slice(0, 22).padEnd(23)} ` +
        `${String(hit.rate ?? "—").padEnd(5)} ${hit.countAsCost ? "是" : "否"}`,
    );
  } else {
    console.log(`  ${String(r.id).padEnd(4)} ${grp} ${chName} ✗ 未匹配到已知 Key`);
  }
}

console.log(`${line("═")}`);
console.log(`\n▸ 指纹匹配：${matched}/${rows.length} 个渠道对上了 Orbit 已知 Key`);
console.log(`▸ 其中带倍率的：${withRate} 个`);
if (rateValues.length > 0) {
  const uniq = [...new Set(rateValues)].sort((a, b) => a - b);
  console.log(`▸ 倍率去重：${uniq.length} 种 → ${uniq.join(", ")}`);
  console.log(
    uniq.length > 1
      ? "  ✓ 存在真实成本差异 → 按成本排优先级有数据可排"
      : "  ⚠ 倍率无差异 → 排序无意义",
  );
}

console.log(`\n${line("═")}\n探测完成（只读；channels.key 未被打印或存储）\n${line("═")}\n`);

await prisma.$disconnect();
