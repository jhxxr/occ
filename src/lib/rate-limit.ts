/**
 * 登录限流（进程内）
 *
 * 这个应用只有一个固定账号、一个固定密码，密码不会过期也没有二次验证 ——
 * 只要没有任何限速，暴露在公网上就是一台可以全速爆破的机器，而且不留痕迹。
 *
 * 两层一起用，缺一不可：
 *
 * 1. 按 IP：失败 N 次后指数退避锁定。正常人打错几次密码几乎无感。
 * 2. 全局：所有 IP 的失败次数合并计一个总账。
 *    因为客户端 IP 只能从 X-Forwarded-For 之类的请求头取，而这个头是
 *    攻击者可以随便写的 —— 每个请求换一个假 IP 就能绕过第 1 层。
 *    本来就只有一个人登录，给全局加个上限不会误伤，却能堵死伪造绕过。
 *
 * 进程内存储：本应用是单实例部署（compose 一个容器），重启即清零，
 * 对「拖慢爆破」这个目的足够；多实例部署需要换成共享存储。
 */

/** 允许连续失败几次后才开始锁定 */
const FREE_ATTEMPTS = 5;
/** 首次锁定时长，之后每多失败一次翻倍 */
const BASE_LOCK_MS = 30_000;
/** 单个 IP 的锁定上限 */
const MAX_LOCK_MS = 15 * 60_000;
/** 多久没有新失败就把计数清掉 */
const FAILURE_TTL_MS = 15 * 60_000;
/** 全局：这个窗口内的失败总数上限 */
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_FAILURES = 30;
const GLOBAL_LOCK_MS = 60_000;
/** 防止伪造 IP 把内存撑爆 */
const MAX_TRACKED_KEYS = 5_000;

interface Bucket {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

const buckets = new Map<string, Bucket>();
const globalFailures: number[] = [];
let globalLockedUntil = 0;

/**
 * 取客户端标识。**这个值不可信**（转发头可伪造），只用于「区分正常用户」，
 * 真正兜底的是全局限流。
 */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function prune(now: number): void {
  for (const [key, b] of buckets) {
    if (b.lockedUntil <= now && now - b.lastFailureAt > FAILURE_TTL_MS) {
      buckets.delete(key);
    }
  }
  // 还是太多，说明正在被伪造 IP 灌 —— 丢掉最老的那批
  if (buckets.size > MAX_TRACKED_KEYS) {
    const sorted = [...buckets.entries()].sort(
      (a, b) => a[1].lastFailureAt - b[1].lastFailureAt,
    );
    for (const [key] of sorted.slice(0, buckets.size - MAX_TRACKED_KEYS)) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** 还要等多少秒（给 Retry-After 用） */
  retryAfterSec: number;
  scope: "ip" | "global" | null;
}

/** 只做检查，不计数 —— 计数发生在真的登录失败之后 */
export function checkLoginAllowed(key: string): RateLimitVerdict {
  const now = Date.now();
  prune(now);

  if (globalLockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((globalLockedUntil - now) / 1000),
      scope: "global",
    };
  }
  const b = buckets.get(key);
  if (b && b.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000),
      scope: "ip",
    };
  }
  return { allowed: true, retryAfterSec: 0, scope: null };
}

/** 登录失败后调用：累计失败并按需锁定 */
export function recordLoginFailure(key: string): void {
  const now = Date.now();

  while (globalFailures.length && now - globalFailures[0]! > GLOBAL_WINDOW_MS) {
    globalFailures.shift();
  }
  globalFailures.push(now);
  if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
    globalLockedUntil = now + GLOBAL_LOCK_MS;
    globalFailures.length = 0;
  }

  const b = buckets.get(key) ?? { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
  // 距上次失败太久就重新计数，避免把偶尔打错累加成永久锁定
  if (now - b.lastFailureAt > FAILURE_TTL_MS) b.failures = 0;
  b.failures += 1;
  b.lastFailureAt = now;
  if (b.failures > FREE_ATTEMPTS) {
    const over = b.failures - FREE_ATTEMPTS - 1;
    b.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS);
  }
  buckets.set(key, b);
}

/** 登录成功后调用：清掉该来源的失败记录 */
export function recordLoginSuccess(key: string): void {
  buckets.delete(key);
}

/** 仅供自检脚本使用 */
export function __resetRateLimit(): void {
  buckets.clear();
  globalFailures.length = 0;
  globalLockedUntil = 0;
}

export const RATE_LIMIT_TUNING = {
  FREE_ATTEMPTS,
  BASE_LOCK_MS,
  MAX_LOCK_MS,
  GLOBAL_MAX_FAILURES,
} as const;
