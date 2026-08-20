/**
 * 自动同步。
 *
 * 上游是别人的站，我们是买方。定时同步的风险不是「跑得慢」，而是**持续**地打
 * 对方：被限流、被封 Key、被当成攻击都有真实代价。所以这里的护栏比调度本身多：
 *
 * 1. 默认关闭。开了才跑，间隔下限 15 分钟（zod 校验拒绝更小的值）。
 * 2. ±10% 抖动：不贴整点，容器重启也不会每次都踩同一时刻。
 * 3. 数据库租约（CAS）：多副本 / 重启都不会同时跑两轮。
 * 4. 全程串行，且所有出网请求都过 host-gate（同主机串行 + 最小间隔 + 429 退避）。
 * 5. 按目标退避 + 错误分类：
 *    - 凭据类（登录失败 / 401 / 403）→ 直接退到上限并标「需人工处理」。
 *      这类错误重试一万次也不会好，而「每小时拿错密码去撞对方登录接口」
 *      恰恰是最像攻击的行为。
 *    - 限流类（429 / 过于频繁）→ 起步就 ×4。
 *    - 网络类 → 15 分钟起指数退避。
 *    成功即清零。
 * 6. 一轮里只要出现限流特征，整个下一轮延后（对方是按站限流的，
 *    只退避单个目标不够）。
 * 7. **手动同步完全不受退避影响** —— 退避只约束定时器。
 *
 * 配置与退避状态都放 AppSetting，没有新表：这些都是可重建的运行时状态。
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { listSyncTargets, type SyncResultItem, type SyncTarget } from "@/lib/sync";
import { getSyncJob, startSyncJob } from "@/lib/sync-runner";
import { sawRateLimitSince } from "@/lib/http/host-gate";

const CONFIG_KEY = "autoSync:config";
const LEASE_KEY = "autoSync:scheduler";
const BACKOFF_KEY = "autoSync:backoff";

/** 间隔下限。比这更密没有意义（一轮本身就要一分多钟），只会给上游加压 */
export const MIN_INTERVAL_MINUTES = 15;
export const DEFAULT_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 24 * 60;

/** 退避阶梯 */
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** 限流类起步倍数：对方已经明说「太快了」，就别只退一档 */
const RATE_LIMIT_MULTIPLIER = 4;

/** 抖动幅度 */
const JITTER_RATIO = 0.1;

/** 租约超过这个时长视为持有者已死 */
const LEASE_STALE_MS = 30 * 60 * 1000;

/** tick 间隔。改配置后最多一分钟生效，不用重启 */
const TICK_MS = 60 * 1000;
/** 进程刚起来先缓一会儿，别和启动时的其它初始化抢 */
const FIRST_TICK_DELAY_MS = 90 * 1000;

export type AutoSyncScope = "all" | "upstream";

export interface AutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  scope: AutoSyncScope;
}

export const DEFAULT_AUTO_SYNC_CONFIG: AutoSyncConfig = {
  enabled: false,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  scope: "all",
};

/** 环境变量硬关：即使数据库里开着也不跑（给不想要定时任务的部署留后门） */
export function autoSyncHardDisabled(): boolean {
  return process.env.AUTO_SYNC_ENABLED === "false";
}

export function normalizeAutoSyncConfig(raw: unknown): AutoSyncConfig {
  const value = (raw ?? {}) as Partial<AutoSyncConfig>;
  const minutes = Number(value.intervalMinutes);
  return {
    enabled: value.enabled === true,
    intervalMinutes: Number.isFinite(minutes)
      ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)))
      : DEFAULT_INTERVAL_MINUTES,
    scope: value.scope === "upstream" ? "upstream" : "all",
  };
}

export async function getAutoSyncConfig(): Promise<AutoSyncConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: CONFIG_KEY } });
  if (!row) return { ...DEFAULT_AUTO_SYNC_CONFIG };
  try {
    return normalizeAutoSyncConfig(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_AUTO_SYNC_CONFIG };
  }
}

export async function saveAutoSyncConfig(
  patch: Partial<AutoSyncConfig>,
): Promise<AutoSyncConfig> {
  const merged = normalizeAutoSyncConfig({ ...(await getAutoSyncConfig()), ...patch });
  const value = JSON.stringify(merged);
  await prisma.appSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value },
    update: { value },
  });
  return merged;
}

// ——— 错误分类与退避 ———

export type FailureClass = "credential" | "rate-limit" | "network";

/**
 * 把失败归类，决定退避多久。
 *
 * 凭据类要单独拎出来：它不会自愈，重试只是白打对方的登录接口。
 */
export function classifyFailure(error: string | undefined): FailureClass {
  const text = (error || "").toLowerCase();
  if (
    text.includes("429") ||
    text.includes("过于频繁") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("请求过多")
  ) {
    return "rate-limit";
  }
  if (
    text.includes("登录失败") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("密码") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("key 无效") ||
    text.includes("无法解密") ||
    text.includes("缺少") ||
    text.includes("invalid api key")
  ) {
    return "credential";
  }
  return "network";
}

/** 连续第 n 次失败该退多久（n 从 1 开始） */
export function backoffMs(failures: number, failureClass: FailureClass): number {
  if (failureClass === "credential") return BACKOFF_MAX_MS;
  const steps = Math.max(1, failures);
  const base = BACKOFF_BASE_MS * 2 ** (steps - 1);
  const scaled = failureClass === "rate-limit" ? base * RATE_LIMIT_MULTIPLIER : base;
  return Math.min(scaled, BACKOFF_MAX_MS);
}

export interface BackoffEntry {
  failures: number;
  /** 早于这个时刻不自动同步该目标 */
  nextAt: string;
  lastAt: string;
  lastError: string;
  failureClass: FailureClass;
  name: string;
}

export type BackoffMap = Record<string, BackoffEntry>;

function targetKey(target: { kind: string; id: string }): string {
  return `${target.kind}:${target.id}`;
}

async function readBackoff(): Promise<{ raw: string | null; map: BackoffMap }> {
  const row = await prisma.appSetting.findUnique({ where: { key: BACKOFF_KEY } });
  if (!row) return { raw: null, map: {} };
  try {
    const parsed = JSON.parse(row.value);
    return {
      raw: row.value,
      map: parsed && typeof parsed === "object" ? (parsed as BackoffMap) : {},
    };
  } catch {
    return { raw: row.value, map: {} };
  }
}

async function writeBackoff(map: BackoffMap): Promise<void> {
  const value = JSON.stringify(map);
  await prisma.appSetting.upsert({
    where: { key: BACKOFF_KEY },
    create: { key: BACKOFF_KEY, value },
    update: { value },
  });
}

export async function getBackoffMap(): Promise<BackoffMap> {
  return (await readBackoff()).map;
}

/**
 * 根据这一轮的结果更新退避表。
 *
 * 只处理本轮实际跑过的目标：没跑到的目标（比如被跳过的）保持原状。
 * 顺手清掉已经不在目标列表里的孤儿键（上游被删了）。
 */
export async function applyResults(
  results: SyncResultItem[],
  liveTargets: SyncTarget[],
  now = Date.now(),
): Promise<BackoffMap> {
  const { map } = await readBackoff();
  const liveKeys = new Set(liveTargets.map(targetKey));

  for (const result of results) {
    const key = targetKey(result);
    if (result.success) {
      delete map[key];
      continue;
    }
    const failureClass = classifyFailure(result.error);
    const failures = (map[key]?.failures ?? 0) + 1;
    map[key] = {
      failures,
      nextAt: new Date(now + backoffMs(failures, failureClass)).toISOString(),
      lastAt: new Date(now).toISOString(),
      lastError: (result.error || "同步失败").slice(0, 200),
      failureClass,
      name: result.name,
    };
  }

  for (const key of Object.keys(map)) {
    if (!liveKeys.has(key)) delete map[key];
  }

  await writeBackoff(map);
  return map;
}

/** 挑出这一轮可以跑的目标；返回被跳过的那些好让界面解释原因 */
export function selectDueTargets(
  targets: SyncTarget[],
  map: BackoffMap,
  now = Date.now(),
): { due: SyncTarget[]; skipped: { target: SyncTarget; entry: BackoffEntry }[] } {
  const due: SyncTarget[] = [];
  const skipped: { target: SyncTarget; entry: BackoffEntry }[] = [];
  for (const target of targets) {
    const entry = map[targetKey(target)];
    if (entry && new Date(entry.nextAt).getTime() > now) {
      skipped.push({ target, entry });
      continue;
    }
    due.push(target);
  }
  return { due, skipped };
}

// ——— 调度状态 ———

interface LeaseState {
  /** 下一轮不早于这个时刻 */
  nextRunAt: string;
  lastRunAt?: string;
  lastFinishedAt?: string;
  lastOk?: number;
  lastFail?: number;
  lastSkipped?: number;
  /** 上一轮命中限流：整轮延后过 */
  lastRateLimited?: boolean;
  /** running 时的持有者标记，配合 lastRunAt 判断死锁 */
  runningToken?: string;
}

export interface AutoSyncStatus {
  config: AutoSyncConfig;
  hardDisabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastOk: number | null;
  lastFail: number | null;
  lastSkipped: number | null;
  lastRateLimited: boolean;
  backoff: (BackoffEntry & { key: string })[];
}

function parseLease(value: string): LeaseState | null {
  try {
    const parsed = JSON.parse(value) as LeaseState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readLease(): Promise<{ raw: string | null; state: LeaseState | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: LEASE_KEY } });
  return {
    raw: row?.value ?? null,
    state: row ? parseLease(row.value) : null,
  };
}

async function writeLease(state: LeaseState, expectRaw: string | null): Promise<boolean> {
  const value = JSON.stringify(state);
  if (expectRaw == null) {
    try {
      await prisma.appSetting.create({ data: { key: LEASE_KEY, value } });
      return true;
    } catch {
      return false;
    }
  }
  const claimed = await prisma.appSetting.updateMany({
    where: { key: LEASE_KEY, value: expectRaw },
    data: { value },
  });
  return claimed.count === 1;
}

/** 带抖动的下一次运行时刻。取整：这是个时间戳，没有小数的意义。 */
export function nextRunAt(intervalMinutes: number, now = Date.now(), rand = Math.random()): number {
  const base = Math.max(MIN_INTERVAL_MINUTES, intervalMinutes) * 60 * 1000;
  const jitter = base * JITTER_RATIO * (rand * 2 - 1);
  return Math.round(now + base + jitter);
}

export async function getAutoSyncStatus(): Promise<AutoSyncStatus> {
  const [config, lease, map] = await Promise.all([
    getAutoSyncConfig(),
    readLease(),
    getBackoffMap(),
  ]);
  return {
    config,
    hardDisabled: autoSyncHardDisabled(),
    nextRunAt: lease.state?.nextRunAt ?? null,
    lastRunAt: lease.state?.lastRunAt ?? null,
    lastFinishedAt: lease.state?.lastFinishedAt ?? null,
    lastOk: lease.state?.lastOk ?? null,
    lastFail: lease.state?.lastFail ?? null,
    lastSkipped: lease.state?.lastSkipped ?? null,
    lastRateLimited: lease.state?.lastRateLimited === true,
    backoff: Object.entries(map).map(([key, entry]) => ({ ...entry, key })),
  };
}

export interface TickOutcome {
  ran: boolean;
  reason?: string;
  ok?: number;
  fail?: number;
  skipped?: number;
}

/**
 * 一次调度检查。到点且拿到租约才真的跑。
 *
 * `force` 只给自检/手动「立即执行一次自动同步」用，仍然遵守退避与租约。
 */
export async function runAutoSyncTick(
  opts: { force?: boolean; now?: number } = {},
): Promise<TickOutcome> {
  if (autoSyncHardDisabled()) return { ran: false, reason: "AUTO_SYNC_ENABLED=false" };

  const config = await getAutoSyncConfig();
  if (!config.enabled) return { ran: false, reason: "未开启" };

  const now = opts.now ?? Date.now();
  const lease = await readLease();

  // 上一轮还在跑（同步运行器里有任务）就跳过，不排队
  const job = await getSyncJob();
  if (job?.state === "running") return { ran: false, reason: "上一轮同步还在跑" };

  const running = lease.state?.runningToken;
  const runningSince = lease.state?.lastRunAt
    ? new Date(lease.state.lastRunAt).getTime()
    : 0;
  if (running && now - runningSince < LEASE_STALE_MS) {
    return { ran: false, reason: "另一个实例正在跑" };
  }

  const due = lease.state?.nextRunAt ? new Date(lease.state.nextRunAt).getTime() : 0;
  if (!opts.force && now < due) return { ran: false, reason: "未到点" };

  // 抢租约：先写成 running，抢不到说明别人先动手了
  const token = randomUUID();
  const claimed = await writeLease(
    {
      ...(lease.state ?? {}),
      nextRunAt: new Date(nextRunAt(config.intervalMinutes, now)).toISOString(),
      lastRunAt: new Date(now).toISOString(),
      runningToken: token,
    },
    lease.raw,
  );
  if (!claimed) return { ran: false, reason: "租约被抢" };

  const targets = await listSyncTargets({ scope: config.scope });
  const map = await getBackoffMap();
  const { due: dueTargets, skipped } = selectDueTargets(targets, map, now);

  if (!dueTargets.length) {
    await finishLease(token, {
      ok: 0,
      fail: 0,
      skipped: skipped.length,
      rateLimited: false,
      intervalMinutes: config.intervalMinutes,
    });
    return { ran: false, reason: "所有目标都在退避中", skipped: skipped.length };
  }

  // 记下开跑时刻，用来判断这一轮里有没有新的限流命中
  const startedAt = Date.now();
  const { job: started, attached } = await startSyncJob({
    trigger: "auto",
    targets: dueTargets,
    label: `自动同步（${config.scope === "upstream" ? "仅上游" : "全部"}）`,
  });

  if (attached) {
    // 极小概率：刚好被手动同步抢在前面。放弃这一轮，等下一次
    await finishLease(token, {
      ok: 0,
      fail: 0,
      skipped: skipped.length,
      rateLimited: false,
      intervalMinutes: config.intervalMinutes,
    });
    return { ran: false, reason: "已有同步任务在跑" };
  }

  // 等它跑完再更新退避表。这个函数由 tick 调用，本身就在后台，不阻塞请求。
  await waitForJob(started.runId);
  const finished = await getSyncJob();
  const results = (finished?.results ?? []).map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    success: entry.success,
    error: entry.error,
  })) as SyncResultItem[];

  await applyResults(results, targets, Date.now());

  // 本轮有主机被限流过 → 整轮延后，而不是只退避单个目标：
  // 对方是按站限流的，继续按原节奏跑等于顶着限流硬打。
  const rateLimited = sawRateLimitSince(startedAt);
  await finishLease(token, {
    ok: finished?.ok ?? 0,
    fail: finished?.fail ?? 0,
    skipped: skipped.length,
    rateLimited,
    intervalMinutes: config.intervalMinutes,
  });

  return {
    ran: true,
    ok: finished?.ok ?? 0,
    fail: finished?.fail ?? 0,
    skipped: skipped.length,
  };
}

async function finishLease(
  token: string,
  info: {
    ok: number;
    fail: number;
    skipped: number;
    rateLimited: boolean;
    intervalMinutes: number;
  },
): Promise<void> {
  const lease = await readLease();
  if (lease.state?.runningToken !== token) return; // 被接管了，别覆盖别人的状态

  const now = Date.now();
  const base = nextRunAt(info.intervalMinutes, now);
  const next = info.rateLimited
    ? Math.min(now + BACKOFF_MAX_MS, now + (base - now) * RATE_LIMIT_MULTIPLIER)
    : base;

  await writeLease(
    {
      nextRunAt: new Date(next).toISOString(),
      lastRunAt: lease.state.lastRunAt,
      lastFinishedAt: new Date(now).toISOString(),
      lastOk: info.ok,
      lastFail: info.fail,
      lastSkipped: info.skipped,
      lastRateLimited: info.rateLimited,
      runningToken: undefined,
    },
    lease.raw,
  );
}

/** 轮询等任务结束；同步运行器自己有心跳超时判定，这里只要跟着它 */
async function waitForJob(runId: string): Promise<void> {
  for (let i = 0; i < 1_200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const job = await getSyncJob();
    if (!job || job.runId !== runId || job.state !== "running") return;
  }
}

declare global {
  var __orbitAutoSyncScheduler: boolean | undefined;
}

export function startAutoSyncScheduler(): void {
  if (globalThis.__orbitAutoSyncScheduler) return;
  if (autoSyncHardDisabled()) return;
  globalThis.__orbitAutoSyncScheduler = true;

  const tick = () => {
    void runAutoSyncTick().catch((error) => {
      console.error("[orbit] 自动同步失败", error);
    });
  };
  // 每分钟检查一次「到点了吗」，而不是把定时器设成用户间隔 ——
  // 改配置立刻生效，不用重启容器。
  const first = setTimeout(tick, FIRST_TICK_DELAY_MS);
  const timer = setInterval(tick, TICK_MS);
  first.unref();
  timer.unref();
}

export const AUTO_SYNC_TUNING = {
  MIN_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  RATE_LIMIT_MULTIPLIER,
  JITTER_RATIO,
  LEASE_STALE_MS,
} as const;
