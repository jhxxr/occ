/**
 * 上游累计消费基线的推进规则。
 *
 * 成本是靠「这一轮的累计消费 − 上一轮的累计消费」算出来的，所以这条基线是
 * 整个成本口径的地基。地基一旦被坏读数污染，账面上完全看不出来：
 *
 *   某轮上游的累计消费接口失败 → 读成 0 → 基线被写成 0
 *   下一轮读回真值 37.94       → 差额 37.94 被当成「今天新增消费」记一次成本
 *
 * 这正是 2026-08-20 那笔 ¥39.50 假成本的成因（MagicAI ¥37.94 + 智元API ¥1.55），
 * 两笔金额都恰好等于各自的全生命周期累计。
 *
 * 所以两条铁律：
 *
 * 1. 「查不到」不等于「花了 0」。读不到就沿用旧基线、计 0 增量。
 * 2. 计 0 增量会让成本偏低，但那是可发现、重新同步就能补上的；
 *    凭空多记一大笔是不可发现的。宁可偏低。
 *
 * 抽成纯函数是为了能被 scripts/check-reporting.ts 覆盖（项目没有测试框架）。
 */

export interface ConsumedBaselineInput {
  /** 本轮从上游读到的累计消费 */
  reported: number;
  /** true = 这一轮没真的读到（接口失败/字段缺失），reported 只是占位 */
  reportedUnknown?: boolean;
  /** 库里存的上一轮基线；null = 还没有基线 */
  previous: number | null;
  /** 是否是这个上游的第一次同步（第一次不把历史累计计成当日成本） */
  isFirstSync: boolean;
}

export interface ConsumedBaselineDecision {
  /** 应该写回库里的基线值 */
  baseline: number;
  /** 本轮可计入成本的账号级增量 */
  delta: number;
  /** 读数缺失，本轮基线未推进 */
  unknown: boolean;
}

export function resolveConsumedBaseline(
  input: ConsumedBaselineInput,
): ConsumedBaselineDecision {
  const unknown = input.reportedUnknown === true;

  // 读不到：基线原样保留（没有旧基线就保持 0，反正也没得比），增量计 0
  if (unknown) {
    return { baseline: input.previous ?? 0, delta: 0, unknown: true };
  }

  const previous = input.previous ?? input.reported;
  // 首次同步只建基线，不把对方的历史累计当成今天的消费
  const delta = input.isFirstSync
    ? 0
    : Math.max(0, input.reported - previous);
  return { baseline: input.reported, delta, unknown: false };
}

export interface AccountFallbackInput {
  /** 账号级增量（打算当成本记账的那个值） */
  delta: number;
  /** 本轮读到的累计消费 */
  reported: number;
  /** 本轮之前库里的基线 */
  previous: number | null;
  /** 本轮是否没读到累计消费 */
  consumedUnknown: boolean;
}

/**
 * Key 级成本同步失败时会回退到账号级增量。这个回退本身就不精确
 * （账号里通常还有不计入中转的 Key），所以遇到下面两种情况必须放弃记账：
 *
 * - 增量恰好等于全部历史累计，且上一轮基线是 0 → 基线曾被坏读数清零，
 *   这不是消费，是整段历史被重记一次。
 * - 本轮压根没读到累计消费。
 */
export function shouldSkipAccountFallback(input: AccountFallbackInput): {
  skip: boolean;
  reason: "unknown-reading" | "baseline-reset" | null;
} {
  if (input.consumedUnknown) return { skip: true, reason: "unknown-reading" };

  const baselineWasZero = (input.previous ?? 0) === 0;
  const deltaIsWholeHistory =
    input.delta > 0 && Math.abs(input.delta - input.reported) < 1e-9;
  if (baselineWasZero && deltaIsWholeHistory) {
    return { skip: true, reason: "baseline-reset" };
  }

  return { skip: false, reason: null };
}
