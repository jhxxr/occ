/**
 * 同步后台任务运行器。
 *
 * 为什么同步不能在 HTTP 请求里等着跑完：整轮同步是分钟级的（优化前实测
 * 3 分 23 秒）。前面的反代到点就返回**自己的 HTML 错误页**（nginx 默认
 * proxy_read_timeout 60s、Cloudflare 100s → 524），浏览器拿它去 JSON.parse
 * 就得到 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`；而服务端
 * 那边同步还在继续跑到底，所以数据最后是对的 —— 「报错了但其实同步成功了」。
 *
 * 所以改成：POST 立刻返回任务 id，前端轮询 GET 拿进度。请求不再长时间挂着，
 * 这一类报错从根上消失。
 *
 * 状态落在 AppSetting（key `sync:job`）而不是内存：容器重启、多副本都不会
 * 各说各话，界面刷新后也能重新贴上正在跑的那一轮。写法沿用 usage-retention
 * 的 CAS 抢占（唯一键 + 比对旧值更新）。
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  listSyncTargets,
  syncAll,
  type SyncResultItem,
  type SyncTarget,
} from "@/lib/sync";

const JOB_KEY = "sync:job";

/**
 * 心跳超过这个时长就认为进程已经没了。
 *
 * 持有者被 kill 时没人去改状态，界面会永远显示「同步中」。每完成一个目标
 * 就续一次心跳，所以这个阈值只需要覆盖「单个目标最久要多久」。
 * 与 sync-lock 的 LOCK_TTL_MS 对齐。
 */
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

export type SyncTrigger = "manual" | "auto";
export type SyncJobState = "running" | "success" | "error" | "interrupted";

export interface SyncJobResultEntry {
  id: string;
  name: string;
  kind: SyncResultItem["kind"];
  success: boolean;
  error?: string;
  usageError?: string;
  /** 下游：写入了几天的真实消费（界面用来显示同步产出） */
  usageDays?: number;
  usageRevenueRmb?: number;
}

export interface SyncJob {
  runId: string;
  trigger: SyncTrigger;
  /** 这一轮同步的范围描述，给界面显示用 */
  scope: string;
  state: SyncJobState;
  total: number;
  done: number;
  ok: number;
  fail: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  /** 当前正在同步的目标名，跑完就清掉 */
  current?: string;
  error?: string;
  results: SyncJobResultEntry[];
}

/** 单条错误留 200 字够定位问题，又不至于把这行撑爆（AppSetting.value 是 TEXT） */
const ERROR_LIMIT = 200;

function trim(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > ERROR_LIMIT ? `${value.slice(0, ERROR_LIMIT)}…` : value;
}

function toEntry(result: SyncResultItem): SyncJobResultEntry {
  return {
    id: result.id,
    name: result.name,
    kind: result.kind,
    success: result.success,
    error: trim(result.error),
    usageError: trim(result.usageError),
    usageDays: result.usageDays,
    usageRevenueRmb: result.usageRevenueRmb,
  };
}

function parseJob(value: string): SyncJob | null {
  try {
    const parsed = JSON.parse(value) as SyncJob;
    return parsed && typeof parsed.runId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** 把 running 但心跳已停的任务读成 interrupted，而不是骗用户说还在跑 */
function withStaleCheck(job: SyncJob | null): SyncJob | null {
  if (!job || job.state !== "running") return job;
  const age = Date.now() - new Date(job.heartbeatAt).getTime();
  if (age < HEARTBEAT_STALE_MS) return job;
  return {
    ...job,
    state: "interrupted",
    current: undefined,
    error: "同步进程中断（服务重启或被终止），请重新触发",
  };
}

async function readRaw(): Promise<{ row: string | null; job: SyncJob | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: JOB_KEY } });
  return { row: row?.value ?? null, job: row ? parseJob(row.value) : null };
}

export async function getSyncJob(): Promise<SyncJob | null> {
  const { job } = await readRaw();
  return withStaleCheck(job);
}

async function writeJob(job: SyncJob): Promise<void> {
  const value = JSON.stringify(job);
  await prisma.appSetting.upsert({
    where: { key: JOB_KEY },
    create: { key: JOB_KEY, value },
    update: { value },
  });
}

/**
 * 进程内也留一份，避免同一实例上并发 POST 各自起一轮同步。
 * 数据库那份 CAS 是给多副本/重启兜底的，两层都要。
 */
declare global {
  var __orbitSyncJobRunning: Promise<void> | undefined;
}

export interface StartSyncOptions {
  trigger: SyncTrigger;
  /** 指定目标；不传则按 scope 取全部启用目标 */
  targets?: SyncTarget[];
  scope?: "all" | "upstream";
  /** 界面上显示的范围描述 */
  label?: string;
  /**
   * 目标之间额外停顿（毫秒或每次求一次）。
   * 自动同步「同态随机」用；手动同步不要传。
   */
  interTargetDelayMs?: number | (() => number);
}

export interface StartSyncResult {
  job: SyncJob;
  /** true = 已有任务在跑，本次直接贴上去，没有新开一轮 */
  attached: boolean;
}

/**
 * 起一轮同步并立刻返回。
 *
 * 已有任务在跑时不排队、不报错，直接把那一轮的状态还给调用方 ——
 * 界面上多点几次按钮应该跟上同一轮进度，而不是叠出好几轮把上游打两遍。
 */
export async function startSyncJob(
  opts: StartSyncOptions,
): Promise<StartSyncResult> {
  const { row, job } = await readRaw();
  const current = withStaleCheck(job);
  if (current?.state === "running") {
    return { job: current, attached: true };
  }

  const targets = opts.targets ?? (await listSyncTargets({ scope: opts.scope }));
  const now = new Date().toISOString();
  const fresh: SyncJob = {
    runId: randomUUID(),
    trigger: opts.trigger,
    scope: opts.label ?? (opts.scope === "upstream" ? "仅上游" : "全部"),
    state: "running",
    total: targets.length,
    done: 0,
    ok: 0,
    fail: 0,
    startedAt: now,
    heartbeatAt: now,
    current: targets[0]?.name,
    results: [],
  };

  // CAS：只有旧值仍是刚读到的那份才算抢到，避免两个请求同时开跑
  const claimed = row
    ? await prisma.appSetting.updateMany({
        where: { key: JOB_KEY, value: row },
        data: { value: JSON.stringify(fresh) },
      })
    : await prisma.appSetting
        .create({ data: { key: JOB_KEY, value: JSON.stringify(fresh) } })
        .then(() => ({ count: 1 }))
        .catch(() => ({ count: 0 }));

  if (claimed.count !== 1) {
    // 别人刚好抢先了：把它那一轮还给调用方
    const latest = await getSyncJob();
    if (latest) return { job: latest, attached: true };
    throw new Error("同步任务启动失败，请重试");
  }

  // 故意不 await：请求要立刻返回。任务在 Node 进程里继续跑到底。
  globalThis.__orbitSyncJobRunning = runJob(fresh, targets, {
    interTargetDelayMs: opts.interTargetDelayMs,
  }).finally(() => {
    globalThis.__orbitSyncJobRunning = undefined;
  });

  return { job: fresh, attached: false };
}

async function runJob(
  job: SyncJob,
  targets: SyncTarget[],
  opts: { interTargetDelayMs?: number | (() => number) } = {},
): Promise<void> {
  const live: SyncJob = { ...job };
  try {
    await syncAll({
      targets,
      interTargetDelayMs: opts.interTargetDelayMs,
      onResult: async (result, done, total) => {
        live.results.push(toEntry(result));
        live.done = done;
        live.total = total;
        if (result.success) live.ok += 1;
        else live.fail += 1;
        live.heartbeatAt = new Date().toISOString();
        live.current = targets[done]?.name;
        // 每个目标写一次：这既是进度，也是心跳
        await writeJob(live).catch(() => {
          // 写状态失败不能中断同步本身；下一个目标会再试
        });
      },
    });
    live.state = "success";
  } catch (error) {
    live.state = "error";
    live.error = trim(error instanceof Error ? error.message : String(error));
  } finally {
    live.current = undefined;
    live.finishedAt = new Date().toISOString();
    live.heartbeatAt = live.finishedAt;
    await writeJob(live).catch((error) => {
      console.error("[orbit] 同步任务收尾写状态失败", error);
    });
  }
}

/** 仅供自检脚本使用 */
export const SYNC_JOB_TUNING = {
  HEARTBEAT_STALE_MS,
  ERROR_LIMIT,
  JOB_KEY,
} as const;

export { withStaleCheck as __withStaleCheck };
