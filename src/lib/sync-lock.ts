import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * 同步互斥锁。
 *
 * 同步是「读基线 → 打一串网络请求 → 写回基线并落一条成本」的读改写，中间
 * 跨了几十秒。两次同步重叠时，两边都读到同一个 lastConsumed、都算出同一段
 * 增量，于是同一笔上游消耗被记两次成本，账面无痕。界面又天然鼓励并发：
 * 全量同步按钮和单卡片按钮各管各的忙碌状态，请求超时后用户还会再点一次。
 *
 * 锁放在 AppSetting 里，靠唯一键和 CAS 保证原子，不依赖内存状态 —— 容器重启、
 * 多副本都不会漏。持有者进程被杀掉时锁不会自动释放，所以带 TTL 兜底。
 */

/** 超过这个时长的锁视为持有者已经死了，可以接管。整轮同步实测约 80 秒。 */
const LOCK_TTL_MS = 15 * 60 * 1000;

export class SyncBusyError extends Error {
  constructor(message = "该对象正在同步中，请等这一轮结束再试") {
    super(message);
    this.name = "SyncBusyError";
  }
}

export type SyncLockScope = "upstream" | "downstream";

function lockKey(scope: SyncLockScope, id: string): string {
  return `sync:lock:${scope}:${id}`;
}

/**
 * 已持有的锁。同一次同步内部会层层转调（整号同步 → 自建站/绑定键同步），
 * 走的是同一个对象，不能把自己挡在门外，所以按异步上下文做可重入。
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** 抢锁成功时返回写进库里的那份值，释放时要用它比对，避免误删别人的锁 */
async function acquire(key: string): Promise<string | null> {
  const now = Date.now();
  const value = JSON.stringify({ at: now, token: randomUUID() });

  try {
    await prisma.appSetting.create({ data: { key, value } });
    return value;
  } catch {
    // 唯一键冲突：已经有人持有，看看是不是死锁
  }

  const existing = await prisma.appSetting.findUnique({ where: { key } });
  if (!existing) return null; // 刚好被别人释放又抢走，这轮当作繁忙

  let heldSince = 0;
  try {
    const parsed = JSON.parse(existing.value) as { at?: unknown };
    heldSince = typeof parsed?.at === "number" ? parsed.at : 0;
  } catch {
    heldSince = 0; // 值坏掉了，按过期处理，否则这个锁永远解不开
  }
  if (now - heldSince < LOCK_TTL_MS) return null;

  // 接管过期锁：要求值仍然等于刚读到的那一份，避免两个接管者同时得手
  const taken = await prisma.appSetting.updateMany({
    where: { key, value: existing.value },
    data: { value },
  });
  return taken.count === 1 ? value : null;
}

async function release(key: string, value: string): Promise<void> {
  // 只删自己写的那份：万一本轮超时被别人接管了，别把对方的锁删掉
  await prisma.appSetting.deleteMany({ where: { key, value } });
}

/**
 * 持锁执行 fn。同一异步上下文里已经持有同一把锁时直接放行（可重入）。
 * 抢不到锁抛 SyncBusyError，由调用方转成对用户可读的结果。
 */
export async function withSyncLock<T>(
  scope: SyncLockScope,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(scope, id);
  const held = heldLocks.getStore();
  if (held?.has(key)) return fn();

  const handle = await acquire(key);
  if (!handle) throw new SyncBusyError();

  const nested = new Set(held ?? []);
  nested.add(key);
  try {
    return await heldLocks.run(nested, fn);
  } finally {
    await release(key, handle).catch(() => {
      // 释放失败不能盖掉正常结果；TTL 会兜底把锁放开
    });
  }
}
