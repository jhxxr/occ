import { prisma } from "@/lib/db";
import { COST_MODE, COST_STATUS } from "@/lib/operating-cost";
import { summarizeRecharges } from "@/lib/recharge";
import { shanghaiDay } from "@/lib/reporting-period";

export const RETIREMENT_TYPE = {
  normal: "NORMAL",
  balanceLoss: "BALANCE_LOSS",
} as const;

export type RetirementType =
  (typeof RETIREMENT_TYPE)[keyof typeof RETIREMENT_TYPE];

export interface RetirementDefaults {
  balance: number;
  costRate: number;
  effectiveRateSource: "recharges" | "provider";
  day: string;
}

export interface RetireProviderOptions {
  type: RetirementType;
  balance?: number;
  costRate?: number;
  day?: string;
  note?: string | null;
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export async function getRetirementDefaults(
  providerId: string,
): Promise<RetirementDefaults> {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  if (!provider) throw new Error("上游不存在");

  const recharge = await summarizeRecharges(providerId);
  return {
    balance: Math.max(0, provider.lastBalance ?? 0),
    costRate: recharge.effectiveRate ?? provider.discountRate,
    effectiveRateSource: recharge.effectiveRate != null ? "recharges" : "provider",
    day: shanghaiDay(),
  };
}

export async function retireProvider(
  providerId: string,
  opts: RetireProviderOptions,
) {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  if (!provider) throw new Error("上游不存在");
  if (provider.retiredAt) throw new Error("该上游已经弃用");

  const defaults = await getRetirementDefaults(providerId);
  const retiredAt = new Date();
  const day = opts.day || defaults.day;
  const balance = Math.max(0, opts.balance ?? defaults.balance);
  const costRate = opts.costRate ?? defaults.costRate;
  if (!Number.isFinite(balance)) throw new Error("核销余额无效");
  if (!Number.isFinite(costRate) || costRate <= 0) {
    throw new Error("购入成本率必须大于 0");
  }

  const writeOffRmb =
    opts.type === RETIREMENT_TYPE.balanceLoss
      ? round4(balance * costRate)
      : 0;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.upstreamProvider.updateMany({
      where: { id: providerId, retiredAt: null },
      data: {
        enabled: false,
        retiredAt,
        retirementType: opts.type,
        retirementNote: opts.note?.trim() || null,
        retiredBalance: balance,
        retiredCostRate: costRate,
        balanceWriteOffRmb: writeOffRmb,
      },
    });
    if (claimed.count !== 1) throw new Error("该上游已经弃用");

    let writeOffEntryId: string | null = null;
    if (writeOffRmb > 0) {
      const entry = await tx.operatingCostEntry.create({
        data: {
          name: `${provider.name} 余额损失核销`,
          amountRmb: writeOffRmb,
          mode: COST_MODE.oneTime,
          startDay: day,
          status: COST_STATUS.active,
          category: "relay",
          providerId,
          note: [
            `上游跑路/余额无法追回：${balance.toFixed(4)} 面值 × ${costRate.toFixed(4)} 元/面值`,
            opts.note?.trim(),
          ]
            .filter(Boolean)
            .join("；"),
        },
      });
      writeOffEntryId = entry.id;
    }

    const updated = await tx.upstreamProvider.update({
      where: { id: providerId },
      data: {
        balanceWriteOffEntryId: writeOffEntryId,
      },
    });

    return {
      provider: updated,
      writeOffEntryId,
      writeOffRmb,
      balance,
      costRate,
      day,
    };
  });
}

export async function restoreProvider(providerId: string) {
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
  });
  if (!provider) throw new Error("上游不存在");
  if (!provider.retiredAt) throw new Error("该上游未处于弃用状态");

  return prisma.$transaction(async (tx) => {
    if (provider.balanceWriteOffEntryId) {
      await tx.operatingCostEntry.updateMany({
        where: {
          id: provider.balanceWriteOffEntryId,
          status: { not: COST_STATUS.void },
        },
        data: { status: COST_STATUS.void },
      });
    }

    return tx.upstreamProvider.update({
      where: { id: providerId },
      data: {
        enabled: true,
        retiredAt: null,
        retirementType: null,
        retirementNote: null,
        retiredBalance: null,
        retiredCostRate: null,
        balanceWriteOffRmb: null,
        balanceWriteOffEntryId: null,
      },
    });
  });
}
