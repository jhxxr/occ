/**
 * 上游充值台账
 *
 * 额度推算（防漏记未勾选 Key 的消耗）：
 *   creditGained = (balanceAfter - balanceBefore) + (consumedAfter - consumedBefore)
 * 其中 consumed 用账号级全量消耗（lastConsumed / dashboard total_actual_cost），
 * 不是仅「计入中转」的 Key。
 *
 * 检测频率：仅在你手动同步 / 记录时计算，不轮询。
 */

import { prisma } from "@/lib/db";

export interface RechargeSummary {
  totalPaidRmb: number;
  totalCredit: number;
  /** 实付 / 获得额度 → 实际购入单价 */
  effectiveRate: number | null;
  count: number;
  pendingCount: number;
}

/** 用前后余额+全量消耗推算获得额度 */
export function inferCreditGained(opts: {
  balanceBefore: number;
  balanceAfter: number;
  consumedBefore: number;
  consumedAfter: number;
}): number {
  const dBal = opts.balanceAfter - opts.balanceBefore;
  const dCon = Math.max(0, opts.consumedAfter - opts.consumedBefore);
  // 充值期间若还在消耗：余额涨幅 + 期间消耗 = 到账额度
  return Math.max(0, dBal + dCon);
}

/**
 * 同步时自动检测：若余额跳升超过阈值，生成 pending 充值记录
 * （额度已自动填好，等你补实付金额）
 */
export async function detectRechargeOnSync(
  providerId: string,
  prev: { balance: number | null; consumed: number | null },
  next: { balance: number; consumed: number },
  opts?: { minCredit?: number },
): Promise<{ detected: boolean; id?: string; creditGained?: number }> {
  if (prev.balance == null || prev.consumed == null) {
    return { detected: false };
  }
  const minCredit = opts?.minCredit ?? 0.5; // 小于 0.5 面值忽略，防抖动
  const credit = inferCreditGained({
    balanceBefore: prev.balance,
    balanceAfter: next.balance,
    consumedBefore: prev.consumed,
    consumedAfter: next.consumed,
  });
  // 余额必须有明显上升才算充值（纯消耗不会触发）
  const balUp = next.balance - prev.balance;
  if (credit < minCredit || balUp < minCredit * 0.3) {
    return { detected: false };
  }

  // 避免短时间重复：1 小时内已有 auto pending/confirmed 且额度接近则跳过
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.upstreamRechargeLog.findFirst({
    where: {
      providerId,
      source: "auto",
      createdAt: { gte: oneHourAgo },
    },
    orderBy: { createdAt: "desc" },
  });
  if (recent && Math.abs(recent.creditGained - credit) < 0.2) {
    return { detected: false };
  }

  const row = await prisma.upstreamRechargeLog.create({
    data: {
      providerId,
      paidRmb: 0,
      creditGained: credit,
      balanceBefore: prev.balance,
      balanceAfter: next.balance,
      consumedBefore: prev.consumed,
      consumedAfter: next.consumed,
      source: "auto",
      status: "pending",
      note: "同步时自动检测到额度增加，请补填实付金额",
      rechargedAt: new Date(),
    },
  });

  return { detected: true, id: row.id, creditGained: credit };
}

/** 手动记录：用当前快照 vs 上一次快照推算额度，你只填钱 */
export async function createManualRecharge(
  providerId: string,
  opts: { paidRmb: number; note?: string; rechargedAt?: Date },
) {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  if (!provider) throw new Error("上游不存在");
  if (provider.lastBalance == null || provider.lastConsumed == null) {
    throw new Error("请先同步一次上游，拿到当前余额与消耗基线");
  }

  // 取上一条已确认记录的 after，或用更早的 snapshot
  const lastRecharge = await prisma.upstreamRechargeLog.findFirst({
    where: { providerId, status: "confirmed" },
    orderBy: { rechargedAt: "desc" },
  });

  let balanceBefore: number;
  let consumedBefore: number;

  if (lastRecharge?.balanceAfter != null && lastRecharge.consumedAfter != null) {
    balanceBefore = lastRecharge.balanceAfter;
    consumedBefore = lastRecharge.consumedAfter;
  } else {
    // 用最近两条 snapshot 推：倒数第二条为 before
    const snaps = await prisma.snapshotLog.findMany({
      where: { upstreamId: providerId },
      orderBy: { timestamp: "desc" },
      take: 2,
    });
    if (snaps.length >= 2) {
      balanceBefore = snaps[1].balance;
      consumedBefore = snaps[1].consumed;
    } else {
      // 只有当前点：无法推算，credit 让用户之后同步修正
      balanceBefore = provider.lastBalance;
      consumedBefore = provider.lastConsumed;
    }
  }

  const balanceAfter = provider.lastBalance;
  const consumedAfter = provider.lastConsumed;
  const creditGained = inferCreditGained({
    balanceBefore,
    balanceAfter,
    consumedBefore,
    consumedAfter,
  });

  // 若推算为 0（例如还没同步到充值后余额），仍允许记录，标记 pending 等下次同步补全
  const status =
    creditGained > 0.01 && opts.paidRmb > 0 ? "confirmed" : "pending";

  const row = await prisma.upstreamRechargeLog.create({
    data: {
      providerId,
      paidRmb: opts.paidRmb,
      creditGained,
      balanceBefore,
      balanceAfter,
      consumedBefore,
      consumedAfter,
      source: "manual",
      status,
      note: opts.note || null,
      rechargedAt: opts.rechargedAt || new Date(),
    },
  });

  // 若有明确 实付+到账，可回写有效购入成本建议（不强制改 discountRate）
  return row;
}

/** 补全 pending：填钱或在同步后重算额度 */
export async function updateRecharge(
  id: string,
  patch: {
    paidRmb?: number;
    note?: string;
    rechargedAt?: Date;
    recalculateCredit?: boolean;
    balanceAfter?: number;
    consumedAfter?: number;
  },
) {
  const row = await prisma.upstreamRechargeLog.findUnique({ where: { id } });
  if (!row) throw new Error("记录不存在");

  let creditGained = row.creditGained;
  const balanceAfter = patch.balanceAfter ?? row.balanceAfter;
  const consumedAfter = patch.consumedAfter ?? row.consumedAfter;

  if (
    patch.recalculateCredit &&
    row.balanceBefore != null &&
    row.consumedBefore != null &&
    balanceAfter != null &&
    consumedAfter != null
  ) {
    creditGained = inferCreditGained({
      balanceBefore: row.balanceBefore,
      balanceAfter,
      consumedBefore: row.consumedBefore,
      consumedAfter,
    });
  }

  const paidRmb = patch.paidRmb ?? row.paidRmb;
  const status =
    paidRmb > 0 && creditGained > 0.01 ? "confirmed" : row.status;

  return prisma.upstreamRechargeLog.update({
    where: { id },
    data: {
      paidRmb,
      creditGained,
      balanceAfter,
      consumedAfter,
      note: patch.note !== undefined ? patch.note : row.note,
      rechargedAt: patch.rechargedAt ?? row.rechargedAt,
      status,
    },
  });
}

export async function listRecharges(providerId: string) {
  return prisma.upstreamRechargeLog.findMany({
    where: { providerId },
    orderBy: { rechargedAt: "desc" },
  });
}

export async function summarizeRecharges(
  providerId: string,
): Promise<RechargeSummary> {
  const rows = await prisma.upstreamRechargeLog.findMany({
    where: { providerId },
  });
  const confirmed = rows.filter((r) => r.status === "confirmed" && r.paidRmb > 0);
  const totalPaidRmb = confirmed.reduce((s, r) => s + r.paidRmb, 0);
  const totalCredit = confirmed.reduce((s, r) => s + r.creditGained, 0);
  return {
    totalPaidRmb,
    totalCredit,
    effectiveRate: totalCredit > 0 ? totalPaidRmb / totalCredit : null,
    count: confirmed.length,
    pendingCount: rows.filter((r) => r.status === "pending").length,
  };
}
