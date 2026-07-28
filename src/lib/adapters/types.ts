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
