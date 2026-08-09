import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { fetchMolifangUsage, MolifangUsage } from "@/lib/molifang/client";

export const MOLIFANG_TYPE = "MOLIFANG";

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

async function loadMolifangProvider(providerId: string) {
  const provider = await prisma.upstreamProvider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error("上游不存在");
  if (provider.type !== MOLIFANG_TYPE) throw new Error("该上游不支持本地多 Key 绑定");
  if (provider.retiredAt) throw new Error("该上游已弃用，不能继续远端同步");
  return provider;
}

async function writeDailyUsage(
  providerId: string,
  keyId: string,
  keyName: string,
  countAsCost: boolean,
  discountRate: number,
  usage: MolifangUsage,
) {
  for (const day of usage.daily) {
    const existing = await prisma.upstreamUsageDaily.findUnique({
      where: { providerId_remoteKeyId_day: { providerId, remoteKeyId: keyId, day: day.day } },
    });
    const rate = existing?.costRateRmb && existing.costRateRmb > 0
      ? existing.costRateRmb
      : discountRate;
    await prisma.upstreamUsageDaily.upsert({
      where: { providerId_remoteKeyId_day: { providerId, remoteKeyId: keyId, day: day.day } },
      create: {
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
        costRateSource: "provider",
        countAsCost,
      },
      update: {
        keyName,
        requests: day.requests,
        actualCost: day.actualCost,
        standardCost: day.standardCost,
        totalTokens: day.totalTokens,
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        costRmb: countAsCost ? day.actualCost * rate : 0,
        costRateRmb: rate,
        costRateSource: existing?.costRateRmb ? existing.costRateSource : "provider",
        countAsCost,
      },
    });
  }
}

export async function addMolifangBoundKey(
  providerId: string,
  input: { name: string; secret: string; countAsCost?: boolean },
) {
  const provider = await loadMolifangProvider(providerId);
  const secret = input.secret.trim();
  const name = input.name.trim();
  if (!name) throw new Error("Key 名称不能为空");
  if (!secret) throw new Error("API Key 不能为空");

  const fingerprint = boundKeyFingerprint(secret);
  const duplicate = await prisma.upstreamBoundKey.findUnique({
    where: { providerId_secretFingerprint: { providerId, secretFingerprint: fingerprint } },
  });
  if (duplicate) throw new Error("该 API Key 已绑定，请勿重复添加");

  const usage = await fetchMolifangUsage(provider.baseUrl, secret);
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
  await refreshMolifangProviderAggregate(providerId);
  return key;
}

export async function syncMolifangBoundKey(providerId: string, keyId: string) {
  const provider = await loadMolifangProvider(providerId);
  const key = await prisma.upstreamBoundKey.findFirst({
    where: { id: keyId, providerId, removedAt: null },
  });
  if (!key) throw new Error("绑定 Key 不存在");
  if (key.status !== "active") throw new Error("该 Key 已停用");
  const secret = decryptSecret(key.secret);
  if (!secret) throw new Error("API Key 无法解密，请重新绑定");

  try {
    const usage = await fetchMolifangUsage(provider.baseUrl, secret);
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

export async function refreshMolifangProviderAggregate(providerId: string) {
  const keys = await prisma.upstreamBoundKey.findMany({
    where: { providerId, status: "active", removedAt: null },
  });
  const balance = keys.reduce((sum, key) => sum + (key.lastBalance ?? 0), 0);
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

export async function syncMolifangProvider(providerId: string) {
  const provider = await loadMolifangProvider(providerId);
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
  for (const key of keys) results.push(await syncMolifangBoundKey(providerId, key.id));
  const aggregate = await refreshMolifangProviderAggregate(providerId);
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
