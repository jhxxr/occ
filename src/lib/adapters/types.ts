/**
 * Unified adapter types for upstream / downstream data fetchers.
 */

export type ProviderType = "NEWAPI" | "SUB2API" | "ONEAPI" | "OTHER";

export interface UpstreamFetchResult {
  success: boolean;
  /** Remaining balance in USD */
  balance: number;
  /** Cumulative used/consumed in USD (0 if unknown) */
  consumed: number;
  /** Human-readable error if success=false */
  error?: string;
  raw?: unknown;
  /** When Sub2API auto-login/refresh issues new tokens */
  authUpdate?: {
    accessToken: string;
    refreshToken?: string | null;
    /** Absolute expiry time if known */
    expiresAt?: Date | null;
  };
}

export interface DownstreamFetchResult {
  success: boolean;
  /** Period or total consumption in USD equivalent */
  consumed: number;
  /** Top-up / revenue amount (currency indicated separately) */
  revenue: number;
  revenueCurrency: "USD" | "CNY";
  error?: string;
  raw?: unknown;
}

export interface UpstreamAdapterInput {
  baseUrl: string;
  apiKey: string;
  type: ProviderType | string;
  /** Quota points that equal $1 (NewAPI default 500000) */
  quotaPerDollar?: number;
  /** Sub2API panel email for auto login */
  accountEmail?: string | null;
  /** Sub2API panel password (plaintext, already decrypted) */
  accountPassword?: string | null;
  /** Sub2API refresh_token */
  refreshToken?: string | null;
  /** Known access token expiry */
  tokenExpiresAt?: Date | string | null;
}

export interface DownstreamAdapterInput {
  baseUrl: string;
  adminKey: string;
  /** NewAPI New-API-User header (token owner id, root often 1) */
  adminUserId?: number;
  quotaPerDollar?: number;
  /** User ids excluded from revenue (test accounts) */
  excludeUserIds?: number[];
  /**
   * CNY: 充值 1:1 人民币，issued 面值数字直接当元（不再 × 汇率）
   * USD: 按美元额度，仪表盘再 × USD/CNY
   */
  revenueCurrency?: "CNY" | "USD";
}

export interface DownstreamUserRow {
  id: number;
  username: string;
  display_name?: string;
  role: number;
  status?: number;
  email?: string;
  quota: number;
  used_quota: number;
  /** (quota + used) in USD */
  issuedUsd: number;
  usedUsd: number;
  request_count?: number;
  /** true if currently excluded from revenue */
  excluded?: boolean;
}

/**
 * 下游按日实际消费
 *
 * 两个口径分开存，别混用：
 * - quota：全部账号的消费（含测试号），跟上游成本对差值用
 * - excludedQuota：其中被排除账号（测试号）烧掉的部分
 *
 * 收入 = quota − excludedQuota。测试号没人付钱，算进收入就是虚增利润。
 */
export interface DownstreamDailyRow {
  /** Asia/Shanghai 日历日 */
  day: string;
  /** 全部账号的原始额度面值 */
  quota: number;
  /** 其中被排除账号消耗的额度面值 */
  excludedQuota: number;
  /** 请求数，来源不支持时为 0 */
  requests: number;
  /** 是否真的按账号拆出了排除项；false 表示拿不到逐账号数据 */
  excludeResolved: boolean;
}

export interface DownstreamGroupDailyRow {
  day: string;
  quota: number;
  requests: number;
  groupName: string;
}

export interface DownstreamDailyUsageResult {
  success: boolean;
  /** 全站权威口径 */
  totals: DownstreamDailyRow[];
  /** 分组归因，接口不支持时为空 */
  groups: DownstreamGroupDailyRow[];
  /** log-stat = 逐日日志求和；data-export = 数据看板聚合 */
  totalSource: "log-stat" | "data-export" | "none";
  /** 是否拿到了整段区间 */
  complete: boolean;
  /** 拉取失败的日期 */
  failedDays: string[];
  /** 测试号是否真的被拆出来了；false 说明收入里还混着测试号消费 */
  excludeResolved: boolean;
  error?: string;
}

export interface DownstreamGroupRateRow {
  groupName: string;
  ratio: number;
  /** ratio 是否为真实读到的值 */
  known: boolean;
}

export interface DownstreamGroupRatesResult {
  success: boolean;
  rates: DownstreamGroupRateRow[];
  /** option = 管理端 GroupRatio；user-groups = 可用分组倍率；group-list = 只拿到名字 */
  source: "option" | "user-groups" | "group-list" | "none";
  error?: string;
}
