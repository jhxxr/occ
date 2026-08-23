/**
 * 只读探测：NewAPI Admin API 的 channel 端点形状。
 *
 * 关键要搞清一件事 —— PUT /api/channel/ 是**整体替换**还是**局部补丁**？
 * 如果是整体替换，那就必须先 GET 完整对象、只改 priority/status、再整体 PUT 回去；
 * 而这又引出第二个问题：GET 回来的 key 是不是被打码了？
 * 若是打码的，整体 PUT 回去会把上游 Key 写坏 —— 这是会直接搞挂线上的。
 *
 * 本脚本只发 GET，不发任何写请求。
 * 不打印 key 内容，只报告它的形状（长度 / 是否含打码字符）。
 */

import "dotenv/config";
import { prisma } from "../src/lib/db.ts";
import { decryptSecret } from "../src/lib/crypto.ts";

function line(c = "─", n = 72) {
  return c.repeat(n);
}

function adminHeaders(token: string, userId: number): Record<string, string> {
  const raw = token.startsWith("Bearer ") ? token.slice(7).trim() : token.trim();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: raw,
    "New-API-User": String(userId),
  };
}

/** 只报形状，绝不回显内容 */
function describeSecret(v: unknown): string {
  if (v === undefined) return "字段不存在";
  if (v === null) return "null";
  const s = String(v);
  if (!s) return "空字符串";
  const masked = /[*•]/.test(s);
  return `长度 ${s.length}${masked ? "，含打码字符(*或•) → 打码值" : "，无打码字符 → 可能是明文"}`;
}

const site = await prisma.downstreamSite.findFirst({
  where: { dbDsn: { not: null } },
  select: { id: true, name: true, baseUrl: true, adminKey: true, adminUserId: true },
});
if (!site) {
  console.log("没有下游站点");
  await prisma.$disconnect();
  process.exit(0);
}

const key = decryptSecret(site.adminKey);
if (!key) {
  console.log("adminKey 无法解密");
  await prisma.$disconnect();
  process.exit(1);
}

const base = site.baseUrl.replace(/\/+$/, "");
const headers = adminHeaders(key, site.adminUserId || 1);

console.log(`\n站点：${site.name}`);
console.log(`Base：${base}`);
console.log(`${line("═")}`);

// 1) 列表端点
console.log("\n▸ GET /api/channel/?p=0&page_size=3");
let firstId: number | null = null;
try {
  const res = await fetch(`${base}/api/channel/?p=0&page_size=3`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(`  HTTP ${res.status}  success=${body.success}  message=${body.message ?? "—"}`);

  const data = body.data as unknown;
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.items)
      ? ((data as Record<string, unknown>).items as unknown[])
      : Array.isArray((data as Record<string, unknown>)?.records)
        ? ((data as Record<string, unknown>).records as unknown[])
        : [];

  console.log(`  data 形状：${Array.isArray(data) ? "数组" : typeof data}，取到 ${items.length} 条`);

  if (items.length > 0) {
    const one = items[0] as Record<string, unknown>;
    firstId = Number(one.id);
    console.log(`  返回字段（${Object.keys(one).length} 个）：`);
    console.log(`    ${Object.keys(one).join(", ")}`);
    console.log(`\n  ▸ 路由相关字段实际值（渠道 #${one.id}）：`);
    for (const f of ["id", "name", "priority", "weight", "status", "auto_ban", "group", "type"]) {
      console.log(`    ${f.padEnd(10)} = ${JSON.stringify(one[f])}`);
    }
    console.log(`\n  ▸ 敏感字段形状（不回显内容）：`);
    console.log(`    key        : ${describeSecret(one.key)}`);
    console.log(`    base_url   : ${one.base_url === undefined ? "字段不存在" : "存在"}`);
    console.log(`    models     : ${one.models === undefined ? "字段不存在" : `长度 ${String(one.models).length}`}`);
  }
} catch (e) {
  console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
}

// 2) 单条端点
if (firstId != null && Number.isFinite(firstId)) {
  console.log(`\n▸ GET /api/channel/${firstId}`);
  try {
    const res = await fetch(`${base}/api/channel/${firstId}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log(`  HTTP ${res.status}  success=${body.success}`);
    const one = body.data as Record<string, unknown> | null;
    if (one && typeof one === "object") {
      console.log(`  返回字段（${Object.keys(one).length} 个）：`);
      console.log(`    ${Object.keys(one).join(", ")}`);
      console.log(`\n  ▸ key 字段形状：${describeSecret(one.key)}`);
      console.log(
        `\n  → 若 key 是打码值，则「GET 完整对象再整体 PUT 回去」会写坏上游 Key，\n` +
          `    必须确认 PUT 支持只传 {id, priority} 的局部更新。`,
      );
    } else {
      console.log("  data 为空或非对象");
    }
  } catch (e) {
    console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${line("═")}\n探测完成（只发 GET，未做任何写入）\n${line("═")}\n`);

await prisma.$disconnect();
