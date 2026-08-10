export interface PrepaidBalanceInput {
  downstreamId: string;
  userId: number;
  role: number;
  quota: number;
  quotaPerUnit: number;
  observedAt: Date;
}

export interface PrepaidLiability {
  totalRmb: number;
  privateRmb: number;
  publicRmb: number;
  excludedRmb: number;
  users: number;
  observedAt: Date | null;
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
    if (balance.role >= 100 || ownership.excludeUserIds.has(balance.userId)) {
      excludedRmb += amount;
      continue;
    }
    users++;
    if (ownership.privateUserIds.has(balance.userId)) privateRmb += amount;
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
    if (!ownership || ownership.excludeUserIds.has(order.userId)) continue;
    const amount = round2(Math.max(0, order.moneyRmb));
    const isPrivate = ownership.privateUserIds.has(order.userId);

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
