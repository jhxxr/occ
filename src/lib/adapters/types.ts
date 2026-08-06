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
  /** User ids marked as private domain (your own promoted users) */
  privateUserIds?: number[];
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
  /** true if marked as private-domain (your own promoted user) */
  isPrivate?: boolean;
}

/**
 * 下游按日实际消费
 *
 * 两个口径分开存，别混用：
 * - quota：全部账号的消费（含测试号），跟上游成本对差值用
 * - excludedQuota：其中被排除账号（测试号）烧掉的部分
 *
 * 收入 = quota − excludedQuota。测试号没人付钱，算进收入就是虚增利润。
 *
 * privateQuota 是收入里属于私域（自己推广的用户）的部分，已剔掉测试号；
 * 公共池 = (quota − excludedQuota) − privateQuota。
 */
export interface DownstreamDailyRow {
  /** Asia/Shanghai 日历日 */
  day: string;
  /** 全部账号的原始额度面值 */
  quota: number;
  /** 其中被排除账号消耗的额度面值 */
  excludedQuota: number;
  /** 其中私域用户消耗的额度面值（不含测试号） */
  privateQuota: number;
  /** 请求数，来源不支持时为 0 */
  requests: number;
  /** 是否真的按账号拆出了排除项；false 表示拿不到逐账号数据 */
  excludeResolved: boolean;
  /** 是否真的按账号拆出了私域；false 表示拿不到逐账号数据 */
  privateResolved: boolean;
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
  /** 私域是否真的被拆出来了；false 说明拿不到逐账号数据 */
  privateResolved: boolean;
  error?: string;
}

/** 日志里按渠道聚合的消费 */
export interface DownstreamChannelUsageRow {
  channelId: number;
  /** 日志里残留的渠道名；渠道被删后 join 不到，为空 */
  channelName: string;
  /** 渠道当前是否还在 NewAPI 的渠道列表里 */
  alive: boolean;
  quota: number;
  requests: number;
  models: string[];
  firstDay: string;
  lastDay: string;
}

export interface DownstreamChannelUsageResult {
  success: boolean;
  channels: DownstreamChannelUsageRow[];
  /** 扫描到的日志条数 */
  scanned: number;
  /** 区间内日志总条数（用于判断是否被截断） */
  total: number;
  /** 是否扫完了整个区间 */
  complete: boolean;
  /** 存活渠道列表是否读取成功；失败时只能靠 channel_name 为空来判断 */
  channelListLoaded: boolean;
  error?: string;
}

export interface ModelDailyRow {
  day: string;
  model: string;
  privateQuota: number;
  publicQuota: number;
  privateRequests: number;
  publicRequests: number;
}

export interface DownstreamModelDailyResult {
  success: boolean;
  rows: ModelDailyRow[];
  scanned: number;
  complete: boolean;
  resolved: boolean;
  failedDays: string[];
  error?: string;
}

