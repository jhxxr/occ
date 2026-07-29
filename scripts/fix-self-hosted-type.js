/**
 * 把误建成第三方 Sub2API 的自建站记录转成 SUB2_ADMIN
 *
 * 背景：自建站要用管理员 X-API-Key 走 /api/v1/admin/*，
 * 而第三方 Sub2API 走邮箱密码 / JWT。两者混在一起时，
 * 同步会拿 JWT 去打自建站，报 "JWT 无效或已过期"。
 *
 * 用法：
 *   node scripts/fix-self-hosted-type.js                  # dry-run，按名字含「自建」匹配
 *   node scripts/fix-self-hosted-type.js --name "自建 Sub2API"
 *   node scripts/fix-self-hosted-type.js --id cxxxx
 *   node scripts/fix-self-hosted-type.js --id cxxxx --apply
 *
 * 转换会写入：
 *   type = SUB2_ADMIN, discountRate = 1, quotaPerDollar = 1
 *   清空 apiKey（作废 JWT）/ accountEmail / accountPassword / refreshToken / tokenExpiresAt
 *   lastBalance = null, lastConsumed = null（自建站不是余额模型）
 *   lastError = "请补填 Admin API Key"
 * 并删除该记录名下的 UpstreamApiKey / UpstreamUsageDaily / UpstreamUsageLog / SnapshotLog
 * （这些是第三方口径的脏数据，对自建站无意义）
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const ID = arg("--id");
const NAME = arg("--name");

async function main() {
  let targets;

  if (ID) {
    const one = await prisma.upstreamProvider.findUnique({ where: { id: ID } });
    targets = one ? [one] : [];
  } else if (NAME) {
    targets = await prisma.upstreamProvider.findMany({
      where: { name: NAME },
    });
  } else {
    // 默认：名字里带「自建」但类型不是 SUB2_ADMIN 的
    const all = await prisma.upstreamProvider.findMany();
    targets = all.filter(
      (p) => p.name.includes("自建") && p.type !== "SUB2_ADMIN",
    );
  }

  if (!targets.length) {
    console.log("没有匹配的记录。用 --id 或 --name 指定，或先看一眼：");
    const all = await prisma.upstreamProvider.findMany({
      select: { id: true, name: true, type: true },
    });
    for (const p of all) console.log(`  ${p.id}  ${p.type.padEnd(11)} ${p.name}`);
    return;
  }

  console.log(APPLY ? "=== 执行转换 ===" : "=== DRY RUN（加 --apply 才写入）===");

  for (const p of targets) {
    if (p.type === "SUB2_ADMIN") {
      console.log(`\n[跳过] ${p.name} (${p.id}) 已经是 SUB2_ADMIN`);
      continue;
    }

    const [keys, usageDaily, usageLogs, snaps] = await Promise.all([
      prisma.upstreamApiKey.count({ where: { providerId: p.id } }),
      prisma.upstreamUsageDaily.count({ where: { providerId: p.id } }),
      prisma.upstreamUsageLog.count({ where: { providerId: p.id } }),
      prisma.snapshotLog.count({ where: { upstreamId: p.id } }),
    ]);

    console.log(`\n${p.name}  (${p.id})`);
    console.log(`  type          ${p.type}  →  SUB2_ADMIN`);
    console.log(`  discountRate  ${p.discountRate}  →  1`);
    console.log(`  quotaPerDollar ${p.quotaPerDollar}  →  1`);
    console.log(`  alertThreshold ${p.alertThreshold}  →  0（自建站无余额预警）`);
    console.log(`  apiKey        ${p.apiKey ? "已设置(JWT，将清空)" : "空"}`);
    console.log(`  accountEmail  ${p.accountEmail || "空"}  →  清空`);
    console.log(`  lastBalance   ${p.lastBalance ?? "null"}  →  null`);
    console.log(`  lastConsumed  ${p.lastConsumed ?? "null"}  →  null`);
    console.log(`  lastError     ${p.lastError || "无"}`);
    console.log(
      `  将删除脏数据：ApiKey ${keys} · UsageDaily ${usageDaily} · UsageLog ${usageLogs} · Snapshot ${snaps}`,
    );

    if (!APPLY) continue;

    await prisma.$transaction([
      prisma.upstreamApiKey.deleteMany({ where: { providerId: p.id } }),
      prisma.upstreamUsageDaily.deleteMany({ where: { providerId: p.id } }),
      prisma.upstreamUsageLog.deleteMany({ where: { providerId: p.id } }),
      prisma.snapshotLog.deleteMany({ where: { upstreamId: p.id } }),
      prisma.upstreamProvider.update({
        where: { id: p.id },
        data: {
          type: "SUB2_ADMIN",
          discountRate: 1,
          quotaPerDollar: 1,
          alertThreshold: 0,
          apiKey: "",
          accountEmail: null,
          accountPassword: null,
          refreshToken: null,
          tokenExpiresAt: null,
          lastBalance: null,
          lastConsumed: null,
          lastError: "请补填 Admin API Key",
        },
      }),
    ]);
    console.log("  ✓ 已转换");
  }

  if (APPLY) {
    console.log(
      "\n完成。下一步：打开 /self-hosted，点该站的「补 Key」填入 admin-xxxx，保存后会自动同步分组与账号。",
    );
  } else {
    console.log("\n以上为预览。确认无误后重跑并加 --apply。");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
