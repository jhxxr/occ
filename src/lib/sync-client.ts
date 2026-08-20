/**
 * 前端调同步接口的统一入口。
 *
 * 两件事：
 *
 * 1. `readJson` —— 响应不是 JSON 就给一句能看懂的话。
 *    直接 `res.json()` 的问题是：中间任何一层（nginx / Cloudflare / frp）
 *    返回自己的 HTML 错误页时，浏览器抛的是
 *    `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` ——
 *    完全看不出发生了什么，更看不出「服务端其实还在跑」。
 *
 * 2. `runSyncJob` —— POST 起任务后轮询进度，不再让一个请求挂几分钟。
 */

const POLL_INTERVAL_MS = 3_000;
/** 轮询兜底上限：超过这么久没结束就不再等，让用户自己刷新看 */
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

export interface SyncJobResultEntry {
  id: string;
  name: string;
  kind: "upstream" | "downstream" | "self-hosted";
  success: boolean;
  error?: string;
  usageError?: string;
  usageDays?: number;
  usageRevenueRmb?: number;
}

export interface SyncJobView {
  runId: string;
  trigger: "manual" | "auto";
  scope: string;
  state: "running" | "success" | "error" | "interrupted";
  total: number;
  done: number;
  ok: number;
  fail: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  current?: string;
  error?: string;
  results: SyncJobResultEntry[];
}

/** 读响应体；不是 JSON 就抛一个说明得清楚的错误 */
export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return (await res.json()) as Record<string, unknown>;
  }

  const body = (await res.text().catch(() => "")).trim();
  const looksLikeHtml = /^<(!doctype|html|head|body)/i.test(body);
  if (looksLikeHtml || !body) {
    // 504/502/524 基本都是反代自己超时了，而不是应用返回的
    const gateway = res.status >= 502 && res.status <= 524;
    throw new Error(
      gateway || !res.ok
        ? `网关返回了非 JSON 响应（HTTP ${res.status}）。请求可能已超时，但服务端可能仍在后台处理，稍后刷新查看结果。`
        : `响应不是 JSON（HTTP ${res.status}）`,
    );
  }
  throw new Error(`${body.slice(0, 200)}（HTTP ${res.status}）`);
}

/** 从 readJson 的结果里取 error 字段，取不到就用兜底文案 */
export function errorOf(payload: Record<string, unknown>, fallback: string): string {
  const value = payload.error;
  return typeof value === "string" && value ? value : fallback;
}

async function fetchJob(): Promise<SyncJobView | null> {
  const res = await fetch("/api/sync", { cache: "no-store" });
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorOf(payload, "读取同步状态失败"));
  const data = payload.data as { job?: SyncJobView | null } | undefined;
  return data?.job ?? null;
}

export interface RunSyncOptions {
  target?: "all" | "upstream" | "downstream" | "self-hosted";
  id?: string;
  /** 每次拿到新进度时回调，用来更新按钮上的 n/N */
  onProgress?: (job: SyncJobView) => void;
}

/**
 * 起一轮同步并等它结束。
 *
 * 已有任务在跑时服务端会直接把那一轮还回来（attached），这里照常贴上去轮询 ——
 * 多点几次按钮跟的是同一轮，不会把上游多打一遍。
 */
export async function runSyncJob(
  opts: RunSyncOptions = {},
): Promise<SyncJobView> {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: opts.target ?? "all",
      ...(opts.id ? { id: opts.id } : {}),
    }),
  });
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorOf(payload, "同步失败"));

  const data = payload.data as { job: SyncJobView; attached: boolean };
  let job = data.job;
  opts.onProgress?.(job);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (job.state === "running") {
    if (Date.now() > deadline) {
      throw new Error("同步耗时过长，已停止等待；请稍后刷新查看结果");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const latest = await fetchJob();
    // 状态行被别人换成新一轮了：本轮结果已经拿不到，按结束处理
    if (!latest || latest.runId !== job.runId) break;
    job = latest;
    opts.onProgress?.(job);
  }
  return job;
}

/** 同步结束后给用户看的一句话 */
export function summarizeSyncJob(job: SyncJobView): {
  text: string;
  tone: "success" | "error";
} {
  if (job.state === "interrupted") {
    return { text: job.error || "同步中断，请重新触发", tone: "error" };
  }
  if (job.state === "error") {
    return { text: job.error || "同步失败", tone: "error" };
  }
  if (job.state === "running") {
    return { text: `同步进行中 ${job.done}/${job.total}`, tone: "success" };
  }
  const withUsageIssue = job.results.filter((r) => r.success && r.usageError).length;
  const note = withUsageIssue ? `，${withUsageIssue} 个有数据警告` : "";
  return {
    text: `同步完成：${job.ok} 成功 / ${job.fail} 失败${note}`,
    tone: job.fail > 0 ? "error" : "success",
  };
}

/** 同步中按钮上的文案 */
export function syncProgressLabel(job: SyncJobView | null): string {
  if (!job || job.total <= 0) return "同步中…";
  return `同步中 ${job.done}/${job.total}`;
}
