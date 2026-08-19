/**
 * 预收款履约资金估算
 *
 * 当前用户余额是尚未消费的预收负债；消费后才会变成「付费消费收入」。
 * 用近期实测的成本结构，把这批预收款换算成：
 *   - 预估收入（付费余额消费完后确认；赠送剩余不确认收入）
 *   - 兑现这批余额大概要再往上游投多少钱（付费 + 赠送都会烧上游）
 *   - 预估毛利
 *
 * 这是规划口径，不是已经发生的收入/成本，绝不回写毛利总账。
 */

export interface CapitalPlanRecentRates {
  /** 近期付费消费收入（已扣赠送确认，测试号不计入） */
  revenueRmb: number;
  /**
   * 近期全站消费面值（含测试号/赠送消费等会烧上游的部分）。
   * 有值时优先用作「上游成本率」分母，比付费收入更贴近真实烧量。
   */
  grossConsumptionRmb?: number;
  /** 近期上游使用成本 */
  upstreamCostRmb: number;
  /** 是否确实拿到了近期上游成本数据；不能用缺数据产生的 0 冒充零成本 */
  upstreamCostAvailable: boolean;
  /** 近期额外成本（采购/订阅等），可 0；不含 orphan 历史补录 */
  operatingCostRmb?: number;
}

export interface CapitalPlanInput {
  /**
   * 当前付费用户未消费余额（RMB 面值，通常已排除测试号）。
   * 可含赠送剩余；估算收入时会再扣 bonusRemaining*。
   */
  prepaidRmb: number;
  privatePrepaidRmb?: number;
  publicPrepaidRmb?: number;
  /** 赠送/兑换码剩余额度折 RMB；消费不确认收入，必须从预估收入剔除 */
  bonusRemainingRmb?: number;
  privateBonusRemainingRmb?: number;
  publicBonusRemainingRmb?: number;
  /** 用户余额快照是否完整；不完整时金额不可信 */
  balanceComplete: boolean;
  recent: CapitalPlanRecentRates;
  /** 当前上游可用余额（按各站购入成本折算的 RMB） */
  upstreamBalanceRmb?: number;
}

export interface CapitalPlanEstimate {
  /** 用户余额面值（扣赠送前，付费账号） */
  balanceRmb: number;
  privateBalanceRmb: number;
  publicBalanceRmb: number;
  /** 已从预估收入剔除的赠送剩余 */
  bonusRemainingRmb: number;
  privateBonusRemainingRmb: number;
  publicBonusRemainingRmb: number;
  /** 预估收入 = max(0, 余额 − 赠送剩余) */
  estimatedRevenueRmb: number;
  privateEstimatedRevenueRmb: number;
  publicEstimatedRevenueRmb: number;
  /**
   * 上游成本 / 近期烧量分母。
   * 分母优先全站消费，否则回退付费收入；无近期烧量时为 null。
   */
  upstreamCostRate: number | null;
  /** 额外成本 / 付费收入 */
  operatingCostRate: number | null;
  /** 兑现当前余额后的预估毛利率 */
  marginRate: number | null;
  /**
   * 兑现全部余额（含赠送）所需的上游成本。
   * 赠送也会烧上游，所以按余额面值 × 上游成本率。
   */
  requiredUpstreamCostRmb: number | null;
  /** 兑现时分摊到的额外成本（只跟付费预估收入挂钩） */
  requiredOperatingCostRmb: number | null;
  /** 已有上游余额（购入成本折算） */
  upstreamBalanceRmb: number;
  /**
   * 还需追加投入上游 = max(0, 所需上游成本 − 已有上游余额)。
   * 余额已覆盖时为 0。
   */
  additionalUpstreamInvestRmb: number | null;
  /** 预估毛利 = 预估收入 − 所需上游 − 所需额外 */
  estimatedProfitRmb: number | null;
  /** 预估毛利是否有足够的近期付费收入来推算额外成本率 */
  profitEstimable: boolean;
  /** 预估毛利不可估算时的原因 */
  profitReason: string | null;
  /** 上游余额是否盖得住所需上游成本 */
  covered: boolean | null;
  /** 余额快照完整且有可用来推算的近期烧量/收入 */
  estimable: boolean;
  balanceComplete: boolean;
  /** 不可估算时的原因（给 UI 提示） */
  reason: string | null;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function round6(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 1_000_000) / 1_000_000;
}

function nonNeg(n: number | null | undefined): number {
  return round2(Math.max(0, Number.isFinite(n as number) ? (n as number) : 0));
}

function rate(part: number, whole: number): number | null {
  if (!(whole > 0) || !Number.isFinite(part)) return null;
  return round6(part / whole);
}

/**
 * 用当前预收余额 + 近期实测成本结构，估算履约所需上游投入与预估收入。
 */
export function estimatePrepaidFulfillment(
  input: CapitalPlanInput,
): CapitalPlanEstimate {
  const hasSplit =
    input.privatePrepaidRmb != null || input.publicPrepaidRmb != null;

  const prepaidRmb = nonNeg(input.prepaidRmb);
  let privateBalanceRmb = nonNeg(input.privatePrepaidRmb);
  let publicBalanceRmb = nonNeg(input.publicPrepaidRmb);

  if (!hasSplit) {
    // 无拆分时不假装全是私域：私域/公共都记 0，总额单独展示。
    privateBalanceRmb = 0;
    publicBalanceRmb = 0;
  }

  const balanceRmb = hasSplit
    ? round2(privateBalanceRmb + publicBalanceRmb)
    : prepaidRmb;

  const hasBonusSplit =
    input.privateBonusRemainingRmb != null ||
    input.publicBonusRemainingRmb != null;
  let privateBonusRemainingRmb = nonNeg(input.privateBonusRemainingRmb);
  let publicBonusRemainingRmb = nonNeg(input.publicBonusRemainingRmb);
  let bonusRemainingRmb = nonNeg(input.bonusRemainingRmb);

  if (hasBonusSplit) {
    bonusRemainingRmb = round2(
      privateBonusRemainingRmb + publicBonusRemainingRmb,
    );
  } else if (bonusRemainingRmb > 0 && hasSplit && balanceRmb > 0) {
    // 总额赠送按余额占比摊到两侧，便于展示；扣减仍以总额为准。
    privateBonusRemainingRmb = round2(
      bonusRemainingRmb * (privateBalanceRmb / balanceRmb),
    );
    publicBonusRemainingRmb = round2(
      bonusRemainingRmb - privateBonusRemainingRmb,
    );
  } else if (!hasBonusSplit) {
    privateBonusRemainingRmb = 0;
    publicBonusRemainingRmb = 0;
  }

  // 赠送剩余不能超过余额面值（台账与快照时点可能不一致）。
  if (bonusRemainingRmb > balanceRmb) {
    bonusRemainingRmb = balanceRmb;
    if (hasSplit && balanceRmb > 0) {
      privateBonusRemainingRmb = round2(
        bonusRemainingRmb * (privateBalanceRmb / balanceRmb),
      );
      publicBonusRemainingRmb = round2(
        bonusRemainingRmb - privateBonusRemainingRmb,
      );
    } else {
      privateBonusRemainingRmb = 0;
      publicBonusRemainingRmb = 0;
    }
  } else if (hasSplit) {
    privateBonusRemainingRmb = Math.min(
      privateBonusRemainingRmb,
      privateBalanceRmb,
    );
    publicBonusRemainingRmb = Math.min(
      publicBonusRemainingRmb,
      publicBalanceRmb,
    );
    bonusRemainingRmb = round2(
      privateBonusRemainingRmb + publicBonusRemainingRmb,
    );
  }

  // 预估收入 = 余额中「付费剩余」；赠送剩余消费不确认收入。
  let privateEstimatedRevenueRmb = 0;
  let publicEstimatedRevenueRmb = 0;
  let estimatedRevenueRmb = 0;

  if (hasSplit) {
    privateEstimatedRevenueRmb = nonNeg(
      privateBalanceRmb - privateBonusRemainingRmb,
    );
    publicEstimatedRevenueRmb = nonNeg(
      publicBalanceRmb - publicBonusRemainingRmb,
    );
    estimatedRevenueRmb = round2(
      privateEstimatedRevenueRmb + publicEstimatedRevenueRmb,
    );
  } else {
    estimatedRevenueRmb = nonNeg(balanceRmb - bonusRemainingRmb);
    privateEstimatedRevenueRmb = 0;
    publicEstimatedRevenueRmb = 0;
  }

  const upstreamBalanceRmb = nonNeg(input.upstreamBalanceRmb);

  const base = {
    balanceRmb,
    privateBalanceRmb,
    publicBalanceRmb,
    bonusRemainingRmb,
    privateBonusRemainingRmb,
    publicBonusRemainingRmb,
    estimatedRevenueRmb,
    privateEstimatedRevenueRmb,
    publicEstimatedRevenueRmb,
    upstreamBalanceRmb,
    balanceComplete: input.balanceComplete,
  };

  const empty = (
    reason: string | null,
    estimable: boolean,
  ): CapitalPlanEstimate => ({
    ...base,
    upstreamCostRate: null,
    operatingCostRate: null,
    marginRate: null,
    requiredUpstreamCostRmb: null,
    requiredOperatingCostRmb: null,
    additionalUpstreamInvestRmb: null,
    estimatedProfitRmb: null,
    profitEstimable: false,
    profitReason: reason,
    covered: null,
    estimable,
    reason,
  });

  if (!input.balanceComplete) {
    return empty("用户余额快照不完整，预收负债不能用来规划上游投入", false);
  }

  const revenue = nonNeg(input.recent.revenueRmb);
  const grossConsumption = nonNeg(input.recent.grossConsumptionRmb);
  const upstreamCost = nonNeg(input.recent.upstreamCostRmb);
  const operatingCost = nonNeg(input.recent.operatingCostRmb);

  // 上游烧量分母：正常情况下全站消费 >= 付费收入。取两者较大值，
  // 同时兜住旧数据中 grossConsumption 缺失或小于 revenue 的异常行。
  const upstreamBase = Math.max(grossConsumption, revenue);
  // 余额面值为 0：无需投入，也无预估收入。
  if (!(balanceRmb > 0)) {
    return {
      ...empty(null, true),
      upstreamCostRate:
        input.recent.upstreamCostAvailable && upstreamBase > 0
          ? rate(upstreamCost, upstreamBase)
          : null,
      operatingCostRate:
        revenue > 0 ? rate(operatingCost, revenue) : operatingCost === 0 ? 0 : null,
      marginRate: null,
      requiredUpstreamCostRmb: 0,
      requiredOperatingCostRmb: 0,
      additionalUpstreamInvestRmb: 0,
      estimatedProfitRmb: 0,
      profitEstimable: true,
      profitReason: null,
      covered: true,
    };
  }

  if (!input.recent.upstreamCostAvailable) {
    return empty(
      "近期上游成本数据未同步，不能把缺失成本按 ¥0.00 估算",
      false,
    );
  }

  if (!(upstreamBase > 0)) {
    return empty(
      "近期没有消费数据，无法用成本结构反推上游投入",
      false,
    );
  }

  const upstreamCostRate = upstreamCost / upstreamBase;
  // 额外成本只跟付费收入确认相关。若近期只有赠送/测试消费且确有额外成本，
  // 没有付费收入分母就不能把额外成本率硬写成 0。
  const operatingCostRate =
    revenue > 0 ? operatingCost / revenue : operatingCost === 0 ? 0 : null;

  const requiredUpstreamCostRmb = round2(balanceRmb * upstreamCostRate);
  const requiredOperatingCostRmb =
    estimatedRevenueRmb === 0
      ? 0
      : operatingCostRate == null
        ? null
        : round2(estimatedRevenueRmb * operatingCostRate);
  const additionalUpstreamInvestRmb = round2(
    Math.max(0, requiredUpstreamCostRmb - upstreamBalanceRmb),
  );
  const estimatedProfitRmb =
    requiredOperatingCostRmb == null
      ? null
      : round2(
          estimatedRevenueRmb -
            requiredUpstreamCostRmb -
            requiredOperatingCostRmb,
        );
  const marginRate =
    estimatedProfitRmb != null && estimatedRevenueRmb > 0
      ? rate(estimatedProfitRmb, estimatedRevenueRmb)
      : null;
  const profitEstimable = estimatedProfitRmb != null;
  const profitReason = profitEstimable
    ? null
    : "近期没有付费消费收入，无法推算额外成本率与预估毛利";

  return {
    ...base,
    upstreamCostRate: round6(upstreamCostRate),
    operatingCostRate:
      operatingCostRate == null ? null : round6(operatingCostRate),
    marginRate,
    requiredUpstreamCostRmb,
    requiredOperatingCostRmb,
    additionalUpstreamInvestRmb,
    estimatedProfitRmb,
    profitEstimable,
    profitReason,
    covered: requiredUpstreamCostRmb <= upstreamBalanceRmb + 1e-9,
    estimable: true,
    reason: null,
  };
}
