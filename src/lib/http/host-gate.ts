/**
 * 出网请求的统一节流闸门。
 *
 * 上游是别人的站，我们是买方。翻日志动辄两百多页，连着打会把对方限流
 * （甚至连累到正常登录），挂上定时同步之后更是持续压力 —— 被当成攻击
 * 是有真实代价的。所以所有打第三方的请求都必须从这里过：
 *
 * - 同一主机的请求**串行**，永不并发；
 * - 每条之间留最小间隔，压住突发；
 * - 命中 429 / 503 就让**整个主机**静默一段（优先按 Retry-After），
 *   这期间排队的请求一起等，而不是各自重试继续加压。
 *
 * 以前这套逻辑只藏在 adapters/index.ts 的私有 fetchJson 里，
 * 而 Sub2API 面板、Sub2API Key 的 /v1/usage、自建站管理端三条路径都是裸
 * fetch，完全绕过它。手动点按钮时问题不大，定时器一挂就是长期裸打。
 *
 * 进程内状态：本应用是单实例部署，重启即清零，对「别把上游打爆」这个目的足够。
 */

/** 同主机最小请求间隔 */
const MIN_REQUEST_GAP_MS = 120;
/** 命中限流后整个主机静默多久（随连续命中递增） */
const RATE_LIMIT_COOLDOWN_MS = 3_000;
/** Retry-After 再长也不等超过这个时间 */
const MAX_COOLDOWN_MS = 60_000;

interface HostState {
  /** 该主机的请求队列尾；串到它后面就能保证串行 */
  chain: Promise<void>;
  /** 早于这个时刻不许发下一条 */
  blockedUntil: number;
  /** 最近一次被限流的时刻，供上层判断要不要退避整轮同步 */
  lastRateLimitedAt: number;
}

const hosts = new Map<string, HostState>();

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateOf(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = {
      chain: Promise.resolve(),
      blockedUntil: 0,
      lastRateLimitedAt: 0,
    };
    hosts.set(host, state);
  }
  return state;
}

/** 解析 Retry-After（秒数形式）；拿不到返回 null */
function retryAfterMs(header: string | null): number | null {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  }
  return null;
}

/**
 * 记一次限流命中，并让该主机静默一段。
 * `attempt` 从 0 开始，用来做指数退避。
 */
export function noteRateLimited(
  host: string,
  retryAfter: string | null,
  attempt = 0,
): number {
  const waitMs =
    retryAfterMs(retryAfter) ??
    Math.min(RATE_LIMIT_COOLDOWN_MS * 2 ** attempt, MAX_COOLDOWN_MS);
  const state = stateOf(host);
  state.blockedUntil = Date.now() + waitMs;
  state.lastRateLimitedAt = Date.now();
  return waitMs;
}

/** 最近 windowMs 内是否有主机被限流过 —— 定时同步用它决定要不要整轮退避 */
export function sawRateLimitSince(since: number): boolean {
  for (const state of hosts.values()) {
    if (state.lastRateLimitedAt >= since) return true;
  }
  return false;
}

/**
 * 排进指定主机的队列并执行 `run`。
 *
 * `run` 里必须自己带超时：半死的上游（连得上、迟迟不回）会把整条队列堵死，
 * 后面同主机的请求全部跟着永久挂起，只能重启容器。
 */
export async function withHostGate<T>(
  url: string,
  run: () => Promise<T>,
): Promise<T> {
  const host = hostOf(url);
  const state = stateOf(host);

  const task = state.chain.then(async () => {
    const now = Date.now();
    if (state.blockedUntil > now) await sleep(state.blockedUntil - now);
    try {
      return await run();
    } finally {
      // 无论成败都留出间隔：失败往往正是打太快的结果
      await sleep(MIN_REQUEST_GAP_MS);
    }
  });

  // 成败都要把链条接上，否则一次异常会永久卡住该主机
  state.chain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** 仅供自检脚本使用 */
export function __resetHostGate(): void {
  hosts.clear();
}

export const HOST_GATE_TUNING = {
  MIN_REQUEST_GAP_MS,
  RATE_LIMIT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
} as const;
