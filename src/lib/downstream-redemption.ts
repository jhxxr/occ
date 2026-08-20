import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { createDownstreamRedemptions } from "@/lib/adapters";
import { fetchDownstreamRedemptionsForSite } from "@/lib/downstream-fetch";

function keyPreview(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function syncDownstreamRedemptions(downstreamId: string) {
  const site = await prisma.downstreamSite.findUnique({ where: { id: downstreamId } });
  if (!site) throw new Error("站点不存在");
  const result = await fetchDownstreamRedemptionsForSite(site);
  if (!result.success || !result.complete) {
    await prisma.downstreamSite.update({
      where: { id: downstreamId },
      data: {
        redemptionLastSyncAt: new Date(),
        redemptionSyncError:
          result.error || `兑换码列表不完整（${result.scanned}/${result.total || "?"}）`,
      },
    });
    throw new Error(result.error || `兑换码列表不完整（${result.scanned}/${result.total || "?"}）`);
  }

  const syncedAt = new Date();
  const giftIntents = await prisma.downstreamGiftCodeIntent.findMany({
    where: { downstreamId },
    select: { id: true, keyHash: true },
  });
  const giftIntentByHash = new Map(giftIntents.map((intent) => [intent.keyHash, intent.id]));
  const matchedIntentIds = new Set<string>();
  const matchedGiftRemoteIds = new Set<number>();
  for (const row of result.rows) {
    const intentId = giftIntentByHash.get(keyHash(row.key));
    if (!intentId) continue;
    matchedIntentIds.add(intentId);
    matchedGiftRemoteIds.add(row.remoteId);
  }
  const knownGiftIds = new Set(
    (
      await prisma.downstreamRedemptionCode.findMany({
        where: { downstreamId, giftManaged: true },
        select: { remoteId: true },
      })
    ).map((row) => row.remoteId),
  );
  for (const remoteId of matchedGiftRemoteIds) knownGiftIds.add(remoteId);

  // 整段重建，而不是逐行 upsert：这张表除了 giftManaged 全是远端派生值，
  // 而 giftManaged 已经在上面从库里读进 knownGiftIds 了，重建时带回去即可。
  // 逐行 upsert 在远端库上实测 ~692ms/行，200 个兑换码要 58 秒；这样是 ~7ms/行。
  // 删除范围只取本轮拉到的 remoteId：远端删掉的码在本地留着，与原行为一致。
  if (result.rows.length) {
    await prisma.$transaction([
      prisma.downstreamRedemptionCode.deleteMany({
        where: {
          downstreamId,
          remoteId: { in: result.rows.map((row) => row.remoteId) },
        },
      }),
      prisma.downstreamRedemptionCode.createMany({
        data: result.rows.map((row) => ({
          downstreamId,
          remoteId: row.remoteId,
          name: row.name,
          keyPreview: keyPreview(row.key),
          quota: row.quota,
          status: row.status,
          giftManaged: knownGiftIds.has(row.remoteId),
          createdAtRemote: row.createdAt,
          redeemedAt: row.redeemedAt,
          usedUserId: row.usedUserId,
          expiredAt: row.expiredAt,
          syncedAt,
        })),
      }),
    ]);
  }

  if (matchedIntentIds.size) {
    await prisma.downstreamGiftCodeIntent.deleteMany({
      where: { id: { in: [...matchedIntentIds] } },
    });
  }
  await prisma.$transaction(
    result.rows
      .filter(
        (row) =>
          knownGiftIds.has(row.remoteId) &&
          row.status === 3 &&
          row.usedUserId &&
          row.redeemedAt &&
          row.quota > 0,
      )
      .map((row) =>
        prisma.downstreamCreditLot.upsert({
          where: { ledgerKey: `redeem:${downstreamId}:${row.remoteId}` },
          create: {
            downstreamId,
            userId: row.usedUserId!,
            ledgerKey: `redeem:${downstreamId}:${row.remoteId}`,
            source: "REDEEM_CODE",
            originalQuota: row.quota,
            remainingQuota: row.quota,
            cashBasisRmb: 0,
            occurredAt: row.redeemedAt!,
            note: `赠送兑换码：${row.name || `#${row.remoteId}`}`,
          },
          update: {},
        }),
      ),
  );
  await prisma.downstreamSite.update({
    where: { id: downstreamId },
    data: { redemptionLastSyncAt: syncedAt, redemptionSyncError: null },
  });
  return { site, rows: result.rows, syncedAt };
}

export async function createGiftRedemptions(input: {
  downstreamId: string;
  name: string;
  quota: number;
  count: number;
  expiredTime?: number;
}) {
  const site = await prisma.downstreamSite.findUnique({ where: { id: input.downstreamId } });
  if (!site) throw new Error("站点不存在");
  const result = await createDownstreamRedemptions(
    {
      baseUrl: site.baseUrl,
      adminKey: decryptSecret(site.adminKey),
      adminUserId: site.adminUserId,
      quotaPerDollar: site.quotaPerDollar,
    },
    {
      name: input.name,
      quota: input.quota,
      count: input.count,
      expiredTime: input.expiredTime,
    },
  );
  if (result.keys.length) {
    try {
      await prisma.downstreamGiftCodeIntent.createMany({
        data: result.keys.map((key) => ({
          downstreamId: input.downstreamId,
          keyHash: keyHash(key),
        })),
        skipDuplicates: true,
      });
    } catch (cause) {
      const error = new Error(
        `兑换码已创建，但赠送标记保存失败；已创建 ${result.keys.length} 个，请勿重试：${cause instanceof Error ? cause.message : String(cause)}`,
      ) as Error & { keys?: string[] };
      error.keys = result.keys;
      throw error;
    }
  }
  if (!result.success) {
    const created = result.keys.length ? `；已创建 ${result.keys.length} 个，请勿重试` : "";
    const error = new Error(`${result.error || "创建兑换码失败"}${created}`) as Error & {
      keys?: string[];
    };
    error.keys = result.keys;
    throw error;
  }
  try {
    await syncDownstreamRedemptions(input.downstreamId);
    return { ...result, syncWarning: undefined as string | undefined };
  } catch (error) {
    return {
      ...result,
      syncWarning: `兑换码已创建，但记录同步失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
