export interface PrepaidBalanceInput {
  downstreamId: string;
  userId: number;
  role: number;
  quota: number;
  quotaPerUnit: number;
  observedAt: Date;
}

export interface BonusRemainingInput {
  downstreamId: string;
  userId: number;
  remainingQuota: number;
}

export interface BonusRemainingSummary {
  totalRmb: number;
  privateRmb: number;
  publicRmb: number;
}

export type PrepaidUserOwnership = "EXCLUDED" | "PRIVATE" | "PUBLIC";

export function classifyPrepaidUser(
  userId: number,
  role: number,
  ownership: PrepaidOwnership,
): PrepaidUserOwnership {
  if (role >= 100 || ownership.excludeUserIds.has(userId)) return "EXCLUDED";
  return ownership.privateUserIds.has(userId) ? "PRIVATE" : "PUBLIC";
}

export interface PrepaidLiability {
  totalRmb: number;
  privateRmb: number;
  publicRmb: number;
  excludedRmb: number;
  users: number;
  observedAt: Date | null;
}

/**
 * 赠送/兑换码剩余额度折 RMB。
 * 排除名单与 role≥100 与预收负债同一套规则；admin 角色用余额快照推断。
 */
export function summarizeBonusRemaining(
  lots: BonusRemainingInput[],
  ownershipBySite: Map<string, PrepaidOwnership>,
  opts: {
    quotaPerUnitBySite: Map<string, number>;
    /**
     * 完整的当前用户余额快照。传入后，已删除用户会被跳过，且每个用户的赠送
     * 剩余最多只能扣到他自己的当前余额，不能串到同归属的其他用户。
     */
    userSnapshotBySite?: Map<
      string,
      Map<number, { role: number; quota: number }>
    >;
    enabledSiteIds?: Set<string>;
  },
): BonusRemainingSummary {
  const remainingByUser = new Map<
    string,
    {
      downstreamId: string;
      userId: number;
      ownership: Exclude<PrepaidUserOwnership, "EXCLUDED">;
      remainingQuota: number;
      currentQuota: number | null;
    }
  >();

  for (const lot of lots) {
    if (opts.enabledSiteIds && !opts.enabledSiteIds.has(lot.downstreamId)) continue;
    const ownership = ownershipBySite.get(lot.downstreamId);
    const qpu = opts.quotaPerUnitBySite.get(lot.downstreamId) || 0;
    if (!ownership || !(qpu > 0)) continue;

    const siteSnapshot = opts.userSnapshotBySite?.get(lot.downstreamId);
    const userSnapshot = siteSnapshot?.get(lot.userId);
    if (opts.userSnapshotBySite && !userSnapshot) continue;

    const userOwnership = classifyPrepaidUser(
      lot.userId,
      userSnapshot?.role ?? 0,
      ownership,
    );
    if (userOwnership === "EXCLUDED") continue;

    const key = `${lot.downstreamId}\u0000${lot.userId}`;
    const current = remainingByUser.get(key) || {
      downstreamId: lot.downstreamId,
      userId: lot.userId,
      ownership: userOwnership,
      remainingQuota: 0,
      currentQuota: userSnapshot ? Math.max(0, userSnapshot.quota) : null,
    };
    current.remainingQuota += Math.max(0, lot.remainingQuota);
    remainingByUser.set(key, current);
  }

  let privateRmb = 0;
  let publicRmb = 0;
  for (const user of remainingByUser.values()) {
    const qpu = opts.quotaPerUnitBySite.get(user.downstreamId) || 0;
    const remainingQuota =
      user.currentQuota == null
        ? user.remainingQuota
        : Math.min(user.remainingQuota, user.currentQuota);
    const amount = remainingQuota / qpu;
    if (user.ownership === "PRIVATE") privateRmb += amount;
    else publicRmb += amount;
  }
  privateRmb = round2(privateRmb);
  publicRmb = round2(publicRmb);
  return {
    privateRmb,
    publicRmb,
    totalRmb: round2(privateRmb + publicRmb),
  };
}

export function summarizePrepaidLiability(
  balances: PrepaidBalanceInput[],
  ownershipBySite: Map<string, PrepaidOwnership>,
): PrepaidLiability {
  let privateRmb = 0;
  let publicRmb = 0;
  let excludedRmb = 0;
  let users = 0;
  let observedAt: Date | null = null;
  for (const balance of balances) {
    const ownership = ownershipBySite.get(balance.downstreamId);
    if (!ownership || !balance.quotaPerUnit) continue;
    const amount = Math.max(0, balance.quota) / balance.quotaPerUnit;
    if (!observedAt || balance.observedAt < observedAt) observedAt = balance.observedAt;
    const userOwnership = classifyPrepaidUser(
      balance.userId,
      balance.role,
      ownership,
    );
    if (userOwnership === "EXCLUDED") {
      excludedRmb += amount;
      continue;
    }
    users++;
    if (userOwnership === "PRIVATE") privateRmb += amount;
    else publicRmb += amount;
  }
  privateRmb = round2(privateRmb);
  publicRmb = round2(publicRmb);
  return {
    privateRmb,
    publicRmb,
    totalRmb: round2(privateRmb + publicRmb),
    excludedRmb: round2(excludedRmb),
    users,
    observedAt,
  };
}

export interface PrepaidOrderInput {
  downstreamId: string;
  userId: number;
  moneyRmb: number;
  status: string;
  completedAt: Date | null;
  /** Frozen ownership for migration/opening entries. */
  ownership?: "PRIVATE" | "PUBLIC";
  /** Frozen entries are not reclassified by later exclusion-list edits. */
  frozen?: boolean;
}

export interface PrepaidOwnership {
  excludeUserIds: Set<number>;
  privateUserIds: Set<number>;
}

export interface PrepaidWindow {
  start: Date;
  end: Date;
}

export interface PrepaidTotals {
  totalRmb: number;
  privateRmb: number;
  publicRmb: number;
  orders: number;
}

export interface PrepaidSummary {
  period: PrepaidTotals;
  month: PrepaidTotals;
  allTime: PrepaidTotals;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function emptyTotals(): PrepaidTotals {
  return { totalRmb: 0, privateRmb: 0, publicRmb: 0, orders: 0 };
}

function add(
  totals: PrepaidTotals,
  amount: number,
  isPrivate: boolean,
): void {
  totals.orders++;
  if (isPrivate) totals.privateRmb += amount;
  else totals.publicRmb += amount;
}

function close(totals: PrepaidTotals): PrepaidTotals {
  const privateRmb = round2(totals.privateRmb);
  const publicRmb = round2(totals.publicRmb);
  return {
    privateRmb,
    publicRmb,
    totalRmb: round2(privateRmb + publicRmb),
    orders: totals.orders,
  };
}

function inWindow(date: Date, window: PrepaidWindow): boolean {
  return date >= window.start && date < window.end;
}

/**
 * 按当前用户归属拆分预收款。排除名单优先，只有成功且已有到账时间的订单入账。
 */
export function summarizePrepaid(
  orders: PrepaidOrderInput[],
  ownershipBySite: Map<string, PrepaidOwnership>,
  windows: { period: PrepaidWindow; month: PrepaidWindow },
): PrepaidSummary {
  const period = emptyTotals();
  const month = emptyTotals();
  const allTime = emptyTotals();

  for (const order of orders) {
    if (order.status.toLowerCase() !== "success" || !order.completedAt) continue;
    const ownership = ownershipBySite.get(order.downstreamId);
    if (!ownership || (!order.frozen && ownership.excludeUserIds.has(order.userId))) continue;
    const amount = round2(Math.max(0, order.moneyRmb));
    const isPrivate = order.ownership
      ? order.ownership === "PRIVATE"
      : ownership.privateUserIds.has(order.userId);

    add(allTime, amount, isPrivate);
    if (inWindow(order.completedAt, windows.month)) add(month, amount, isPrivate);
    if (inWindow(order.completedAt, windows.period)) add(period, amount, isPrivate);
  }

  return {
    period: close(period),
    month: close(month),
    allTime: close(allTime),
  };
}
