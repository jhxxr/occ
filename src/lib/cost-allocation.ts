export interface OwnershipCostAllocationInput {
  totalCostRmb: number;
  privateRevenueRmb: number;
  publicRevenueRmb: number;
  privateModelCostRmb: number;
  fallbackCostRmb: number;
}

export interface OwnershipCostAllocation {
  privateCostRmb: number;
  publicCostRmb: number;
  privateProfitRmb: number;
  publicProfitRmb: number;
  measuredProfitRmb: number;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/**
 * 将总成本拆给私域和公共池，并让成本、毛利两套合计始终闭合。
 *
 * 已按模型对齐的私域成本直接归私域；剩余成本按收入占比分摊。
 * 公共池成本用总成本减私域成本得到，避免两边各自四舍五入后对不上总账。
 */
export function allocateOwnershipCosts(
  input: OwnershipCostAllocationInput,
): OwnershipCostAllocation {
  const totalRevenueRmb = round2(
    input.privateRevenueRmb + input.publicRevenueRmb,
  );
  const privateShare =
    totalRevenueRmb > 0 ? input.privateRevenueRmb / totalRevenueRmb : 1;
  const privateCostRmb = round2(
    input.privateModelCostRmb + input.fallbackCostRmb * privateShare,
  );
  const publicCostRmb = round2(input.totalCostRmb - privateCostRmb);
  const privateProfitRmb = round2(
    input.privateRevenueRmb - privateCostRmb,
  );
  const publicProfitRmb = round2(input.publicRevenueRmb - publicCostRmb);

  return {
    privateCostRmb,
    publicCostRmb,
    privateProfitRmb,
    publicProfitRmb,
    measuredProfitRmb: round2(totalRevenueRmb - input.totalCostRmb),
  };
}
