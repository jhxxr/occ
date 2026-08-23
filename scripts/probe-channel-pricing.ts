/**
 * 只读探测：NewAPI 库里到底有哪些「渠道 → 成本 / 路由」可用字段。
 *
 * 自动调度需要三样东西，这个脚本就是去确认它们各自存不存在：
 *   1. 路由旋钮   channels.priority / weight / status / auto_ban
 *   2. 成本依据   channels 上有没有任何倍率列；options 里的定价配置
 *   3. 映射线索   channels.base_url 能不能自动对上 Orbit 的 UpstreamProvider
 *
 * 严格只读：只发 SELECT，且只查 INFORMATION_SCHEMA / channels / options / abilities。
 *
 * 不打印任何凭据：
 *   - 绝不 SELECT channels.key（那是上游 API Key）
 *   - options 只按白名单取定价项，其余一律不读
 *   - base_url 只显示 host，不显示 path/query（防路径里带 token）
 *
 *   npm run probe:pricing
 */

import "dotenv/config";
import type { RowDataPacket } from "mysql2";
import type mysql from "mysql2/promise";
import { prisma } from "../src/lib/db.ts";
import { decryptSecret } from "../src/lib/crypto.ts";
import { withNewApiDb } from "../src/lib/newapi-db.ts";

/** options 里只读这些定价键；其它键可能是 SMTP/支付密钥，一律不碰 */
const PRICING_OPTION_KEYS = [
  "ModelRatio",
  "CompletionRatio",
  "CacheRatio",
  "ModelPrice",
  "GroupRatio",
  "UserUsableGroups",
] as const;

/** channels 上任何看起来像倍率/价格的列名（存在即报告） */
const COST_HINT_PATTERNS = [
  "ratio",
  "price",
  "cost",
  "rate",
  "multiplier",
  "discount",
  "quota_per",
];

/** 路由调度直接要用的列 */
const ROUTING_COLUMNS = [
  "priority",
  "weight",
  "status",
  "auto_ban",
  "group",
  "models",
  "base_url",
  "type",
  "tag",
];

function line(char = "─", n = 68): string {
  return char.repeat(n);
}

function header(title: string): void {
  console.log(`\n${line("═")}\n${title}\n${line("═")}`);
}

/** 只留 host[:port]，丢掉 path/query —— 路径里可能带 token */
function safeHost(raw: string): string {
  const v = (raw || "").trim();
  if (!v) return "(空)";
  try {
    const u = new URL(v.includes("://") ? v : `https://${v}`);
    return u.host || "(无法解析)";
  } catch {
    return "(无法解析)";
  }
}

async function columnsOf(
  conn: mysql.Connection,
  table: string,
): Promise<{ name: string; type: string }[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table],
  );
  return (rows || []).map((r) => ({
    name: String(r.name || ""),
    type: String(r.type || ""),
  }));
}

async function tableExists(
  conn: mysql.Connection,
  table: string,
): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table],
  );
  return Boolean(rows?.[0]);
}

/** 1. channels 表结构：路由旋钮齐不齐、有没有成本列 */
async function probeChannelsSchema(conn: mysql.Connection): Promise<Set<string>> {
  header("1 / 4  channels 表结构");

  if (!(await tableExists(conn, "channels"))) {
    console.log("✗ 无 channels 表 —— 这个库不是 NewAPI 主库？");
    return new Set();
  }

  const cols = await columnsOf(conn, "channels");
  const names = new Set(cols.map((c) => c.name.toLowerCase()));
  console.log(`共 ${cols.length} 列\n`);

  console.log("▸ 路由旋钮（自动调度直接要写的）");
  for (const want of ROUTING_COLUMNS) {
    const hit = cols.find((c) => c.name.toLowerCase() === want);
    console.log(
      hit ? `  ✓ ${want.padEnd(12)} ${hit.type}` : `  ✗ ${want.padEnd(12)} 不存在`,
    );
  }

  console.log("\n▸ 疑似成本 / 倍率列（关键：判断成本能不能从库里直接读）");
  const costCols = cols.filter((c) => {
    const n = c.name.toLowerCase();
    if (n === "used_quota" || n === "quota") return false; // 那是用量不是价格
    return COST_HINT_PATTERNS.some((p) => n.includes(p));
  });
  if (costCols.length === 0) {
    console.log("  （无）→ 成本无法从 channels 直接取，必须外部映射");
  } else {
    for (const c of costCols) console.log(`  ? ${c.name.padEnd(20)} ${c.type}`);
  }

  console.log("\n▸ 其余列（供参考，已剔除 key 等凭据列名不展示值）");
  const shown = new Set([...ROUTING_COLUMNS, ...costCols.map((c) => c.name)]);
  const rest = cols.map((c) => c.name).filter((n) => !shown.has(n.toLowerCase()));
  console.log(`  ${rest.join(", ") || "(无)"}`);

  return names;
}

/** 2. 渠道样本 + base_url 能否自动对上 Orbit 的 UpstreamProvider */
async function probeChannelRows(
  conn: mysql.Connection,
  cols: Set<string>,
): Promise<void> {
  header("2 / 4  渠道样本与自动映射可行性");

  if (cols.size === 0) return;

  const pick = (name: string, fallback: string) =>
    cols.has(name)
      ? name === "group"
        ? "`group` AS group_name"
        : name
      : `${fallback} AS ${name === "group" ? "group_name" : name}`;

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id, name,
            ${pick("status", "0")},
            ${pick("priority", "0")},
            ${pick("weight", "0")},
            ${pick("group", "''")},
            ${pick("base_url", "''")},
            ${pick("auto_ban", "0")}
       FROM channels
      ORDER BY id ASC`,
  );

  const list = rows || [];
  console.log(`共 ${list.length} 个渠道\n`);

  // base_url → Orbit UpstreamProvider 自动匹配率
  const providers = await prisma.upstreamProvider.findMany({
    where: { retiredAt: null },
    select: { id: true, name: true, baseUrl: true, discountRate: true },
  });
  const byHost = new Map<string, (typeof providers)[number]>();
  for (const p of providers) byHost.set(safeHost(p.baseUrl), p);

  console.log(
    `Orbit 在用上游 ${providers.length} 个：${
      providers.map((p) => `${p.name}(¥${p.discountRate})`).join(", ") || "(无)"
    }\n`,
  );

  console.log(
    "  id   状态 优先 权重 分组            上游 host                 → Orbit 上游",
  );
  console.log(`  ${line("─", 84)}`);

  let matched = 0;
  const hasBaseUrl = cols.has("base_url");
  for (const r of list) {
    const host = hasBaseUrl ? safeHost(String(r.base_url || "")) : "(无此列)";
    const hit = byHost.get(host);
    if (hit) matched++;
    console.log(
      `  ${String(r.id).padEnd(4)} ${String(r.status).padEnd(4)} ` +
        `${String(r.priority).padEnd(4)} ${String(r.weight).padEnd(4)} ` +
        `${String(r.group_name || "-").slice(0, 14).padEnd(15)} ` +
        `${host.slice(0, 24).padEnd(25)} ${hit ? `✓ ${hit.name}` : "✗ 未匹配"}`,
    );
  }

  console.log(`\n▸ base_url 自动匹配：${matched}/${list.length} 个渠道能直接对上 Orbit 上游`);
  if (matched === list.length && list.length > 0) {
    console.log("  → 成本映射可以全自动，无需手工绑定");
  } else if (matched > 0) {
    console.log(`  → 可自动预填 ${matched} 个，剩余 ${list.length - matched} 个需手工绑定`);
  } else {
    console.log("  → 无法自动匹配，需要手工绑定 channel → UpstreamProvider");
  }
}

/** 3. options 定价配置（只读白名单键） */
async function probePricingOptions(conn: mysql.Connection): Promise<void> {
  header("3 / 4  options 定价配置（只读白名单键）");

  if (!(await tableExists(conn, "options"))) {
    console.log("✗ 无 options 表");
    return;
  }

  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT \`key\`, \`value\` FROM options WHERE \`key\` IN (?)`,
    [PRICING_OPTION_KEYS as unknown as string[]],
  );

  const found = new Map<string, string>();
  for (const r of rows || []) found.set(String(r.key || ""), String(r.value ?? ""));

  for (const key of PRICING_OPTION_KEYS) {
    const raw = found.get(key);
    if (raw === undefined) {
      console.log(`  ✗ ${key.padEnd(18)} 未配置`);
      continue;
    }
    if (!raw.trim()) {
      console.log(`  ○ ${key.padEnd(18)} 空值`);
      continue;
    }
    // 定价项是 JSON；只报条目数 + 少量样本（模型名与数字不是敏感信息）
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const entries = Object.entries(parsed);
      const sample = entries
        .slice(0, 3)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("  ");
      console.log(
        `  ✓ ${key.padEnd(18)} ${entries.length} 项   ${sample}${
          entries.length > 3 ? "  …" : ""
        }`,
      );
    } catch {
      console.log(`  ✓ ${key.padEnd(18)} 非 JSON，长度 ${raw.length}`);
    }
  }

  console.log(
    "\n  注意：以上是**卖价**口径（你收下游多少钱），不是上游采购成本。\n" +
      "  上游成本只在 Orbit 的 UpstreamProvider.discountRate 里。",
  );
}

/** 4. abilities：NewAPI 真正的路由表 */
async function probeAbilities(conn: mysql.Connection): Promise<void> {
  header("4 / 4  abilities 路由表（NewAPI 按 group×model 选渠道的依据）");

  if (!(await tableExists(conn, "abilities"))) {
    console.log("✗ 无 abilities 表（可能是较老版本）");
    return;
  }

  const cols = await columnsOf(conn, "abilities");
  console.log(`列：${cols.map((c) => c.name).join(", ")}\n`);

  const names = new Set(cols.map((c) => c.name.toLowerCase()));
  if (!names.has("group") || !names.has("model")) {
    console.log("缺少 group/model 列，跳过聚合");
    return;
  }

  const priorityExpr = names.has("priority") ? "priority" : "NULL";
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT \`group\` AS group_name,
            COUNT(DISTINCT model) AS models,
            COUNT(*) AS rows_cnt,
            COUNT(DISTINCT channel_id) AS channels,
            MIN(${priorityExpr}) AS min_pri,
            MAX(${priorityExpr}) AS max_pri
       FROM abilities
      GROUP BY \`group\`
      ORDER BY rows_cnt DESC
      LIMIT 20`,
  );

  console.log("  分组            模型数  渠道数  优先级范围");
  console.log(`  ${line("─", 50)}`);
  for (const r of rows || []) {
    console.log(
      `  ${String(r.group_name || "(空)").slice(0, 14).padEnd(15)} ` +
        `${String(r.models).padEnd(7)} ${String(r.channels).padEnd(7)} ` +
        `${r.min_pri ?? "-"} ~ ${r.max_pri ?? "-"}`,
    );
  }

  console.log(
    "\n  → 同一 group×model 下有多个渠道时，NewAPI 按 priority 选高的、\n" +
      "    同优先级按 weight 随机。这就是「按成本排优先级」要写的目标。",
  );
}

// ── main ────────────────────────────────────────────────────────────────

const sites = await prisma.downstreamSite.findMany({
  orderBy: { createdAt: "asc" },
  select: { id: true, name: true, enabled: true, dbDsn: true },
});

const bound = sites.filter((s) => s.dbDsn);

console.log(`\n下游站点 ${sites.length} 个，已绑定 DSN ${bound.length} 个`);

if (bound.length === 0) {
  console.log("\n没有已绑定数据库的下游站点 —— 先在「下游站点」里绑 DSN 再跑本脚本。");
  await prisma.$disconnect();
  process.exit(0);
}

for (const site of bound) {
  console.log(`\n\n${line("█")}`);
  console.log(`站点：${site.name}${site.enabled ? "" : "（已停用）"}`);
  console.log(line("█"));

  const plain = decryptSecret(site.dbDsn!);
  if (!plain) {
    console.log("✗ DSN 无法解密（ENCRYPTION_SECRET 换过？）");
    continue;
  }

  try {
    await withNewApiDb(plain, async (conn) => {
      const cols = await probeChannelsSchema(conn);
      await probeChannelRows(conn, cols);
      await probePricingOptions(conn);
      await probeAbilities(conn);
    });
  } catch (e) {
    console.log(`\n✗ 探测失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${line("═")}\n探测完成（全程只读，未修改任何数据）\n${line("═")}\n`);

await prisma.$disconnect();
