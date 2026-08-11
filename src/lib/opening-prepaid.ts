import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const OPENING_PREPAID_DAY = "2026-08-01";
const OPENING_PREPAID_INSTANT = new Date(`${OPENING_PREPAID_DAY}T00:00:00+08:00`);
const DEFAULT_QUOTA_PER_UNIT = 500_000;

type Ownership = "PRIVATE" | "PUBLIC";

function parseIds(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value || "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.map(Number).filter((id) => Number.isFinite(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

export interface OpeningPrepaidPreview {
  downstreamId: string;
  name: string;
  openingDay: string;
  users: number;
  existing: number;
  privateRmb: number;
  publicRmb: number;
  totalRmb: number;
  excludedRmb: number;
  observedAt: Date;
  applied: boolean;
}

type OpeningRow = {
  downstreamId: string;
  userId: number;
  openingDay: string;
  ownership: Ownership;
  openingQuota: number;
  quotaPerUnit: number;
  moneyRmb: number;
  observedAt: Date;
};

function summarizeRows(input: {
  downstreamId: string;
  name: string;
  rows: OpeningRow[];
  excludedRmb?: number;
  observedAt: Date;
  applied: boolean;
}): OpeningPrepaidPreview {
  const privateRmb = input.rows
    .filter((row) => row.ownership === "PRIVATE")
    .reduce((sum, row) => sum + row.moneyRmb, 0);
  const publicRmb = input.rows
    .filter((row) => row.ownership === "PUBLIC")
    .reduce((sum, row) => sum + row.moneyRmb, 0);
  return {
    downstreamId: input.downstreamId,
    name: input.name,
    openingDay: OPENING_PREPAID_DAY,
    users: input.rows.length,
    existing: input.applied ? input.rows.length : 0,
    privateRmb: round2(privateRmb),
    publicRmb: round2(publicRmb),
    totalRmb: round2(privateRmb + publicRmb),
    excludedRmb: round2(input.excludedRmb || 0),
    observedAt: input.observedAt,
    applied: input.applied,
  };
}

async function loadSite(
  downstreamId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const site = await client.downstreamSite.findUnique({
    where: { id: downstreamId },
    include: {
      userBalances: {
        where: { complete: true },
        orderBy: { userId: "asc" },
      },
      openingPrepaids: {
        where: { openingDay: OPENING_PREPAID_DAY },
        orderBy: { userId: "asc" },
      },
      topups: {
        where: {
          status: "success",
          completedAt: { gte: OPENING_PREPAID_INSTANT },
        },
        select: { userId: true, amount: true },
      },
      rechargeOps: {
        where: {
          status: "APPLIED",
          createdAt: { gte: OPENING_PREPAID_INSTANT },
        },
        select: { userId: true, creditedQuota: true },
      },
      redemptionCodes: {
        where: {
          status: 3,
          redeemedAt: { gte: OPENING_PREPAID_INSTANT },
          usedUserId: { not: null },
        },
        select: { usedUserId: true, quota: true },
      },
    },
  });
  if (!site) throw new Error("站点不存在");
  return site;
}

function persistedPreview(site: Awaited<ReturnType<typeof loadSite>>) {
  if (!site.openingPrepaidAppliedAt) return null;
  const rows = site.openingPrepaids.map((row) => ({
    downstreamId: row.downstreamId,
    userId: row.userId,
    openingDay: row.openingDay,
    ownership: row.ownership === "PRIVATE" ? "PRIVATE" as const : "PUBLIC" as const,
    openingQuota: row.openingQuota,
    quotaPerUnit: row.quotaPerUnit,
    moneyRmb: row.moneyRmb,
    observedAt: row.observedAt,
  }));
  return summarizeRows({
    downstreamId: site.id,
    name: site.name,
    rows,
    excludedRmb: site.openingPrepaidExcludedRmb,
    observedAt: rows.reduce(
      (latest, row) => row.observedAt > latest ? row.observedAt : latest,
      site.openingPrepaidAppliedAt,
    ),
    applied: true,
  });
}

function buildOpeningRows(site: Awaited<ReturnType<typeof loadSite>>) {
  if (!site.balanceLastSyncAt || site.balanceSyncError || !site.userBalances.length) {
    throw new Error(site.balanceSyncError || "用户余额尚未完整同步，请先同步站点");
  }

  if (!site.topupBackfillComplete || site.topupSyncError) {
    throw new Error(site.topupSyncError || "充值订单历史尚未完整同步，请先同步站点");
  }
  if (!site.redemptionLastSyncAt || site.redemptionSyncError) {
    throw new Error(site.redemptionSyncError || "兑换码历史尚未完整同步，请先同步兑换码");
  }
  if (
    site.balanceLastSyncAt < site.topupLastSyncAt! ||
    site.balanceLastSyncAt < site.redemptionLastSyncAt
  ) {
    throw new Error("充值和兑换码同步后余额尚未刷新，请再次同步用户余额");
  }

  const excluded = parseIds(site.excludeUserIds);
  const privateUsers = parseIds(site.privateUserIds);
  const quotaPerUnit = site.quotaPerDollar || DEFAULT_QUOTA_PER_UNIT;
  const postOpeningQuota = new Map<number, number>();
  const addPostOpening = (userId: number, quota: number) => {
    if (!(quota > 0)) return;
    postOpeningQuota.set(userId, (postOpeningQuota.get(userId) || 0) + quota);
  };
  for (const topup of site.topups) {
    addPostOpening(topup.userId, topup.amount * quotaPerUnit);
  }
  for (const operation of site.rechargeOps) {
    addPostOpening(operation.userId, operation.creditedQuota);
  }
  for (const redemption of site.redemptionCodes) {
    if (redemption.usedUserId != null) {
      addPostOpening(redemption.usedUserId, redemption.quota);
    }
  }

  const rows: OpeningRow[] = [];
  let excludedRmb = 0;
  for (const balance of site.userBalances) {
    const totalIssuedQuota = Math.max(0, balance.quota + balance.usedQuota);
    const openingQuota = Math.max(
      0,
      totalIssuedQuota - (postOpeningQuota.get(balance.userId) || 0),
    );
    const moneyRmb = openingQuota / quotaPerUnit;
    if (balance.role >= 100 || excluded.has(balance.userId)) {
      excludedRmb += moneyRmb;
      continue;
    }
    if (!(openingQuota > 0)) continue;
    rows.push({
      downstreamId: site.id,
      userId: balance.userId,
      openingDay: OPENING_PREPAID_DAY,
      ownership: privateUsers.has(balance.userId) ? "PRIVATE" : "PUBLIC",
      openingQuota,
      quotaPerUnit,
      moneyRmb,
      observedAt: balance.observedAt,
    });
  }
  return { rows, excludedRmb };
}

export async function previewOpeningPrepaid(
  downstreamId: string,
): Promise<OpeningPrepaidPreview> {
  const site = await loadSite(downstreamId);
  const persisted = persistedPreview(site);
  if (persisted) return persisted;
  const { rows, excludedRmb } = buildOpeningRows(site);
  return summarizeRows({
    downstreamId,
    name: site.name,
    rows,
    excludedRmb,
    observedAt: site.balanceLastSyncAt!,
    applied: false,
  });
}

export async function applyOpeningPrepaid(downstreamId: string) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM DownstreamSite WHERE id = ${downstreamId} FOR UPDATE`;
    const lockedSite = await tx.downstreamSite.findUnique({
      where: { id: downstreamId },
      select: { openingPrepaidAppliedAt: true },
    });
    if (!lockedSite) throw new Error("站点不存在");
    if (lockedSite.openingPrepaidAppliedAt) return false;

    const site = await loadSite(downstreamId, tx);
    const { rows, excludedRmb } = buildOpeningRows(site);
    for (const row of rows) {
      await tx.downstreamOpeningPrepaid.upsert({
        where: {
          downstreamId_userId_openingDay: {
            downstreamId,
            userId: row.userId,
            openingDay: OPENING_PREPAID_DAY,
          },
        },
        create: row,
        update: {},
      });
    }
    await tx.downstreamSite.update({
      where: { id: downstreamId },
      data: {
        openingPrepaidAppliedAt: new Date(),
        openingPrepaidExcludedRmb: round2(excludedRmb),
      },
    });
    return true;
  });
  if (!result) return previewOpeningPrepaid(downstreamId);
  return previewOpeningPrepaid(downstreamId);
}
