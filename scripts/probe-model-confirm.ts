/**
 * 只读探测：模型确认流程可用性。
 *
 * 目的是回答「自动获取上游模型 → 我人工删减 → 落库」这条链上，
 * NewAPI 现成给了哪几步，Orbit 只需要补哪一步。
 *
 *   GET /api/channel/fetch_models/:id   拉上游真实模型列表（只读）
 *   GET /api/channel/:id                看当前已启用 models + 忽略名单
 *
 * 只发 GET。不打印 key。
 */

import "dotenv/config";
import { prisma } from "../src/lib/db.ts";
import { decryptSecret } from "../src/lib/crypto.ts";

function line(c = "─", n = 74) {
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

function splitModels(raw: unknown): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const site = await prisma.downstreamSite.findFirst({
  where: { dbDsn: { not: null } },
  select: { name: true, baseUrl: true, adminKey: true, adminUserId: true },
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

// 取渠道列表
const listRes = await fetch(`${base}/api/channel/?p=0&page_size=100`, {
  method: "GET",
  headers,
  signal: AbortSignal.timeout(30_000),
});
const listBody = (await listRes.json()) as Record<string, unknown>;
const d = listBody.data as Record<string, unknown>;
const items = (Array.isArray(d) ? d : (d?.items as unknown[]) || []) as Record<
  string,
  unknown
>[];

console.log(`\n站点：${site.name}    渠道 ${items.length} 个`);
console.log(line("═"));

// 1) 当前 models 与「忽略名单」现状
console.log("\n▸ 各渠道当前已启用模型数 / 上游更新待处理状态\n");
console.log("  ch   渠道名                 已启用  待新增  待移除  已忽略");
console.log(`  ${line("─", 66)}`);

let anyPending = 0;
for (const one of items) {
  const models = splitModels(one.models);
  let settings: Record<string, unknown> = {};
  try {
    const raw = one.other_info || one.settings || one.setting;
    if (typeof raw === "string" && raw.trim()) settings = JSON.parse(raw);
    else if (raw && typeof raw === "object") settings = raw as Record<string, unknown>;
  } catch {
    /* 忽略解析失败 */
  }
  const pendingAdd = (settings.upstream_model_update_last_detected_models ||
    settings.UpstreamModelUpdateLastDetectedModels ||
    []) as unknown[];
  const pendingRemove = (settings.upstream_model_update_last_removed_models ||
    settings.UpstreamModelUpdateLastRemovedModels ||
    []) as unknown[];
  const ignored = (settings.upstream_model_update_ignored_models ||
    settings.UpstreamModelUpdateIgnoredModels ||
    []) as unknown[];
  if (pendingAdd.length || pendingRemove.length) anyPending++;

  console.log(
    `  ${String(one.id).padEnd(4)} ${String(one.name || "").slice(0, 21).padEnd(22)} ` +
      `${String(models.length).padEnd(7)} ${String(pendingAdd.length).padEnd(7)} ` +
      `${String(pendingRemove.length).padEnd(7)} ${ignored.length}`,
  );
}
console.log(`\n  有待处理上游变更的渠道：${anyPending} 个`);

// 2) 实测 fetch_models —— 挑一个启用中的渠道
const target = items.find((o) => Number(o.status) === 1);
if (target) {
  console.log(`\n${line("═")}`);
  console.log(`▸ 实测 GET /api/channel/fetch_models/${target.id}（${target.name}）`);
  console.log(line("═"));
  try {
    const res = await fetch(`${base}/api/channel/fetch_models/${target.id}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log(`  HTTP ${res.status}  success=${body.success}  message=${body.message ?? "—"}`);
    const upstream = (body.data as unknown[]) || [];
    if (Array.isArray(upstream) && upstream.length > 0) {
      const enabled = new Set(splitModels(target.models));
      const up = upstream.map(String);
      const extra = up.filter((m) => !enabled.has(m));
      const missing = [...enabled].filter((m) => !up.includes(m));
      console.log(`\n  上游实际提供 ${up.length} 个模型`);
      console.log(`  当前已启用   ${enabled.size} 个`);
      console.log(`  ✚ 上游有但未启用（可选择加入）：${extra.length} 个`);
      console.log(`      ${extra.slice(0, 12).join(", ")}${extra.length > 12 ? " …" : ""}`);
      console.log(`  ✖ 已启用但上游已无（建议移除）：${missing.length} 个`);
      console.log(`      ${missing.slice(0, 12).join(", ") || "(无)"}`);
      console.log(
        `\n  → 这就是「自动获取」的原料。你删减的动作 = 从 ${extra.length} 个候选里挑，\n` +
          `    未选的进 ignore 名单，下次不再提示。`,
      );
    } else {
      console.log("  data 为空 —— 该渠道上游可能不支持 /v1/models 或凭据已失效");
    }
  } catch (e) {
    console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${line("═")}\n探测完成（只发 GET，未修改任何数据）\n${line("═")}\n`);

await prisma.$disconnect();
