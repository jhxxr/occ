/**
 * 上游记录的两种身份
 *
 * UpstreamProvider 表同时装着两类东西，它们的账完全不同：
 *
 * - 中转上游（NEWAPI / SUB2API / MOLIFANG / ONEAPI / OTHER）
 *   别人的站，我们是买方。余额模型：充钱 → 余额 → 消耗。
 *   成本 = 消耗面值 × discountRate（每面值单位实付人民币）。
 *
 * - 自建 Sub2API（SUB2_ADMIN）
 *   我们自己部署的站，存的是管理员 X-API-Key，走 /api/v1/admin/*。
 *   没有余额可查，不能用中转上游那套探测。
 *   账是：官方计价用量 × 分组卖出倍率 = 卖出收入，账号采购成本另记。
 *
 * 所以余额、预警、成本饼图这些只对中转上游有意义，自建站必须单独走。
 */

export const SELF_HOSTED_TYPE = "SUB2_ADMIN";

/** 可以配到「上游站点」页面的第三方类型 */
export const RELAY_TYPES = [
  "NEWAPI",
  "SUB2API",
  "MOLIFANG",
  "ONEAPI",
  "OTHER",
] as const;

export type RelayType = (typeof RELAY_TYPES)[number];

export function isSelfHosted(type: string | null | undefined): boolean {
  return (type || "").toUpperCase() === SELF_HOSTED_TYPE;
}

/** Prisma where 片段：只要中转上游 */
export const relayOnly = { type: { not: SELF_HOSTED_TYPE } } as const;

/** Prisma where 片段：只要自建站 */
export const selfHostedOnly = { type: SELF_HOSTED_TYPE } as const;

/** 自建站在 UI 上的统一叫法 */
export const SELF_HOSTED_LABEL = "自建上游";
