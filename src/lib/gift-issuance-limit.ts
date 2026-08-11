const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_RMB_PER_CODE = 1_000;
const MAX_RMB_PER_BATCH = 5_000;

const issuedAt: number[] = [];

function prune(now: number): void {
  while (issuedAt.length && now - issuedAt[0]! >= WINDOW_MS) issuedAt.shift();
}

export interface GiftIssuanceVerdict {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Process-local financial guard for the single-instance deployment.
 * Value caps remain effective even after a restart; the burst counter resets.
 */
export function validateGiftIssuanceValue(input: {
  quota: number;
  count: number;
  quotaPerUnit: number;
}): void {
  const quotaPerUnit = input.quotaPerUnit || 500_000;
  const rmbPerCode = input.quota / quotaPerUnit;
  const batchRmb = rmbPerCode * input.count;
  if (rmbPerCode > MAX_RMB_PER_CODE) {
    throw new Error(`单个赠送码不能超过 ¥${MAX_RMB_PER_CODE.toLocaleString("zh-CN")}`);
  }
  if (batchRmb > MAX_RMB_PER_BATCH) {
    throw new Error(`单批赠送总额不能超过 ¥${MAX_RMB_PER_BATCH.toLocaleString("zh-CN")}`);
  }
}

export function checkGiftIssuanceAllowed(now = Date.now()): GiftIssuanceVerdict {
  prune(now);
  if (issuedAt.length >= MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - issuedAt[0]!)) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Record only after the remote creation attempt starts. */
export function recordGiftIssuance(now = Date.now()): void {
  prune(now);
  issuedAt.push(now);
}

/** Only used by self-check scripts. */
export function __resetGiftIssuanceLimit(): void {
  issuedAt.length = 0;
}

export const GIFT_ISSUANCE_LIMITS = {
  WINDOW_MS,
  MAX_REQUESTS_PER_WINDOW,
  MAX_RMB_PER_CODE,
  MAX_RMB_PER_BATCH,
} as const;
