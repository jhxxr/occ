import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { fetchSub2ApiKeyUsage } from "@/lib/sub2api-key/client";
import type { Sub2ApiKeyUsage } from "@/lib/sub2api-key/client";
import { isSub2ApiKeyType } from "@/lib/provider-kinds";
import { selectSharedAccountBalance } from "@/lib/sub2api-key/aggregate";
import { SyncBusyError, withSyncLock } from "@/lib/sync-lock";

export function boundKeyFingerprint(secret: string): string {
  return createHash("sha256").update(secret.trim()).digest("hex");
}

export function publicBoundKey(key: {
  id: string;
  name: string;
  keyPreview: string;
  status: string;
  countAsCost: boolean;
  lastBalance: number | null;
  lastTotalActualCost: number | null;
  lastTodayActualCost: number | null;
  lastModelStats: string | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  removedAt: Date | null;
  createdAt: Date;
}) {
  let modelStats: unknown[] = [];
  try {
    const parsed = JSON.parse(key.lastModelStats || "[]");
    if (Array.isArray(parsed)) modelStats = parsed;
  } catch {
    modelStats = [];
  }
  return {
    id: key.id,
    name: key.name,
    keyPreview: key.keyPreview,
    status: key.status,
    countAsCost: key.countAsCost,
    lastBalance: key.lastBalance,
    lastTotalActualCost: key.lastTotalActualCost,
    lastTodayActualCost: key.lastTodayActualCost,
    modelStats,
    lastSyncAt: key.lastSyncAt,
    lastSuccessAt: key.lastSuccessAt,
    lastError: key.lastError,
    removedAt: key.removedAt,
    createdAt: key.createdAt,
  };
}

async function loadSub2ApiKeyProvider(providerId: string) {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error("上游不存在");
  if (!isSub2ApiKeyType(provider.type)) throw new Error("该上游不是 Sub2API Key 模式");
  if (provider.retiredAt) throw new Error("该上游已弃用，不能继续远端同步");
  return provider;
}

async function writeDailyUsage(
  providerId: string,
  keyId: string,
  keyName: string,
  countAsCost: boolean,
  discountRate: number,
  usage: Sub2ApiKeyUsage,
) {
  if (!usage.daily.length) return;

  // 已有行的 costRateRmb 是「当时那一天真实的成本率」，不能被现在的 provider
  // 折扣改写（折扣会变，历史成本率不能跟着漂）。所以先整段取回基线，再重建。
  //
  // 原来是每天先 findUnique 再 upsert —— 一天两次往返，upsert 在远端库上实测
  // ~692ms/行。改成一次 findMany + deleteMany + createMany 后是 ~7ms/行。
  const days = usage.daily.map((day) => day.day);
  const existingRows = await prisma.upstreamUsageDaily.findMany({
    where: { providerId, remoteKeyId: keyId, day: { in: days } },
    select: { day: true, costRateRmb: true, costRateSource: true },
  });
  const existingByDay = new Map(existingRows.map((row) => [row.day, row]));

  const rows = usage.daily.map((day) => {
    const existing = existingByDay.get(day.day);
    const frozen = !!(existing?.costRateRmb && existing.costRateRmb > 0);
    const rate = frozen ? existing!.costRateRmb : discountRate;
    return {
      providerId,
      remoteKeyId: keyId,
      keyName,
      day: day.day,
      requests: day.requests,
      actualCost: day.actualCost,
      standardCost: day.standardCost,
      totalTokens: day.totalTokens,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      costRmb: countAsCost ? day.actualCost * rate : 0,
      costRateRmb: rate,
      // 已冻结的行沿用它原来的来源标记，新行记 provider
      costRateSource: frozen ? existing!.costRateSource : "provider",
      countAsCost,
    };
  });

  // 删与建同一个事务：中间那一瞬这些天是空的，恰好被报表读到就会看见成本归零。
  await prisma.$transaction([
    prisma.upstreamUsageDaily.deleteMany({
      where: { providerId, remoteKeyId: keyId, day: { in: days } },
    }),
    prisma.upstreamUsageDaily.createMany({ data: rows }),
  ]);
}

export async function addSub2ApiKeyBoundKey(
  providerId: string,
  input: { name: string; secret: string; countAsCost?: boolean },
) {
  const provider = await loadSub2ApiKeyProvider(providerId);
  const secret = input.secret.trim();
  const name = input.name.trim();
  if (!name) throw new Error("Key 名称不能为空");
  if (!secret) throw new Error("API Key 不能为空");

  const fingerprint = boundKeyFingerprint(secret);
  const duplicate = await prisma.upstreamBoundKey.findUnique({
    where: { providerId_secretFingerprint: { providerId, secretFingerprint: fingerprint } },
  });
  if (duplicate) throw new Error("该 API Key 已绑定，请勿重复添加");

  const usage = await fetchSub2ApiKeyUsage(provider.baseUrl, secret);
  const countAsCost = input.countAsCost ?? true;
  const key = await prisma.upstreamBoundKey.create({
    data: {
      providerId,
      name,
      secret: encryptSecret(secret),
      secretFingerprint: fingerprint,
      keyPreview: maskSecret(secret),
      countAsCost,
      lastBalance: usage.balance,
      lastTotalActualCost: usage.totalActualCost,
      lastTodayActualCost: usage.todayActualCost,
      lastModelStats: JSON.stringify(usage.modelStats).slice(0, 100_000),
      lastSyncAt: new Date(),
      lastSuccessAt: new Date(),
    },
  });
  await writeDailyUsage(providerId, key.id, name, countAsCost, provider.discountRate, usage);
  await refreshSub2ApiKeyProviderAggregate(providerId);
  return key;
}

export async function syncSub2ApiKeyBoundKey(providerId: string, keyId: string) {
  // 单 Key 的“立即同步”同样会推进累计基线；与供应商全量同步共用一把锁。
  return withSyncLock("upstream", providerId, () =>
    runSub2ApiKeyBoundKeySync(providerId, keyId),
  );
}

async function runSub2ApiKeyBoundKeySync(providerId: string, keyId: string) {
  const provider = await loadSub2ApiKeyProvider(providerId);
  const key = await prisma.upstreamBoundKey.findFirst({
    where: { id: keyId, providerId, removedAt: null },
  });
  if (!key) throw new Error("绑定 Key 不存在");
  if (key.status !== "active") throw new Error("该 Key 已停用");
  const secret = decryptSecret(key.secret);
  if (!secret) throw new Error("API Key 无法解密，请重新绑定");

  try {
    const usage = await fetchSub2ApiKeyUsage(provider.baseUrl, secret);
    const previous = key.lastTotalActualCost;
    const reset = previous != null && usage.totalActualCost < previous;
    const delta = previous == null || reset
      ? 0
      : Math.max(0, usage.totalActualCost - previous);
    await writeDailyUsage(
      providerId,
      key.id,
      key.name,
      key.countAsCost,
      provider.discountRate,
      usage,
    );
    await prisma.upstreamBoundKey.update({
      where: { id: key.id },
      data: {
        lastBalance: usage.balance,
        lastTotalActualCost: usage.totalActualCost,
        lastTodayActualCost: usage.todayActualCost,
        lastModelStats: JSON.stringify(usage.modelStats).slice(0, 100_000),
        lastSyncAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: reset ? "上游累计用量已重置，本轮未计增量" : null,
      },
    });
    return { keyId: key.id, name: key.name, success: true as const, delta, reset };
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步失败";
    await prisma.upstreamBoundKey.update({
      where: { id: key.id },
      data: { lastSyncAt: new Date(), lastError: message.slice(0, 300) },
    });
    return { keyId: key.id, name: key.name, success: false as const, delta: 0, error: message };
  }
}

export async function refreshSub2ApiKeyProviderAggregate(providerId: string) {
  const keys = await prisma.upstreamBoundKey.findMany({
    where: { providerId, status: "active", removedAt: null },
  });
  // /v1/usage 的余额是供应商账号级余额，不是每条 Key 的独立额度。
  const balance = selectSharedAccountBalance(keys) ?? 0;
  const consumed = keys.reduce((sum, key) => sum + (key.lastTotalActualCost ?? 0), 0);
  const business = keys.reduce(
    (sum, key) => sum + (key.countAsCost ? key.lastTotalActualCost ?? 0 : 0),
    0,
  );
  await prisma.upstreamProvider.update({
    where: { id: providerId },
    data: { lastBalance: balance, lastConsumed: consumed, lastBusinessConsumed: business },
  });
  return { keys: keys.length, balance, consumed, business };
}

export async function syncSub2ApiKeyProvider(providerId: string) {
  // 这条路径既能从「全量同步」进来，也能从上游用量页单独触发。两边重叠会
  // 各自推进 Key 基线并各写一条成本快照。锁是可重入的，外层已经持有时直通。
  try {
    return await withSyncLock("upstream", providerId, () =>
      runSub2ApiKeyProviderSync(providerId),
    );
  } catch (e) {
    if (!(e instanceof SyncBusyError)) throw e;
    const provider = await prisma.upstreamProvider.findUnique({
      where: { id: providerId },
      select: { lastBalance: true, lastConsumed: true, lastBusinessConsumed: true },
    });
    return {
      success: false as const,
      error: "上一轮同步还没跑完，本次已跳过（避免重复记账）",
      keysTotal: 0,
      keys: 0,
      succeeded: 0,
      failed: 0,
      billableKeys: 0,
      businessDelta: 0,
      balance: provider?.lastBalance ?? 0,
      consumed: provider?.lastConsumed ?? 0,
      business: provider?.lastBusinessConsumed ?? 0,
    };
  }
}

async function runSub2ApiKeyProviderSync(providerId: string) {
  const provider = await loadSub2ApiKeyProvider(providerId);
  const keys = await prisma.upstreamBoundKey.findMany({
    where: { providerId, status: "active", removedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!keys.length) {
    await prisma.upstreamProvider.update({
      where: { id: providerId },
      data: { lastSyncAt: new Date(), lastError: "尚未绑定启用的 API Key" },
    });
    return {
      success: false as const,
      error: "尚未绑定启用的 API Key",
      keysTotal: 0,
      keys: 0,
      succeeded: 0,
      failed: 0,
      billableKeys: 0,
      businessDelta: 0,
      balance: provider.lastBalance ?? 0,
      consumed: provider.lastConsumed ?? 0,
      business: provider.lastBusinessConsumed ?? 0,
    };
  }

  const results = [];
  for (const key of keys) results.push(await syncSub2ApiKeyBoundKey(providerId, key.id));
  const aggregate = await refreshSub2ApiKeyProviderAggregate(providerId);
  const succeeded = results.filter((result) => result.success);
  const failed = results.filter((result) => !result.success);
  const businessDelta = succeeded.reduce((sum, result) => {
    const key = keys.find((item) => item.id === result.keyId);
    return sum + (key?.countAsCost ? result.delta : 0);
  }, 0);
  const lastError = failed.length
    ? `${failed.length}/${keys.length} 个 Key 同步失败：${failed.map((item) => item.name).join("、")}`
    : null;

  await prisma.$transaction([
    prisma.snapshotLog.create({
      data: {
        upstreamId: providerId,
        balance: aggregate.balance,
        consumed: aggregate.consumed,
        deltaConsumed: businessDelta,
        costRmb: businessDelta * provider.discountRate,
        raw: JSON.stringify({
          costNote: "bound-keys",
          keys: keys.length,
          succeeded: succeeded.length,
          failed: failed.length,
        }),
      },
    }),
    prisma.upstreamProvider.update({
      where: { id: providerId },
      data: { lastSyncAt: new Date(), lastError },
    }),
  ]);

  return {
    success: succeeded.length > 0,
    error: succeeded.length ? undefined : lastError || "全部 Key 同步失败",
    ...aggregate,
    keysTotal: keys.length,
    succeeded: succeeded.length,
    failed: failed.length,
    billableKeys: keys.filter((key) => key.countAsCost).length,
    businessDelta,
  };
}
