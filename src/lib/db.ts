import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * 同步的写入形状：为什么不是逐行 upsert，也不是把 upsert 塞进 $transaction。
 *
 * 数据库通常不在应用同一台机器上（生产部署实测单次往返 ~90ms）。同步逻辑大量是
 * 「按天/按模型/按 Key 逐行写」，在这条链路上实测同样 150 行：
 *
 *   逐行 await upsert              692 ms/行   ← upsert 先查再写，一行两个来回
 *   $transaction([150 个 upsert])  322 ms/行   ← 事务内仍是串行，只省了自动提交
 *   Promise.all(upsert)             29 ms/行   ← 靠连接池并发把往返叠起来
 *   deleteMany + createMany          7 ms/行   ← createMany 是一条多值 INSERT
 *
 * 所以两种写法，按表的性质选：
 *
 * - 纯派生表（能整段重算的日聚合）→ 一个事务里 `deleteMany` + `createMany`。
 *   删除条件必须精确覆盖本轮要重写的键、且只覆盖这些键：范围放大就会连带
 *   删掉本轮没拉到的那些天（例如拉取失败的日期），那不是重算，是丢数据。
 *   删和建放同一个事务：分两次提交时中间那一瞬这段数据是空的，恰好被报表
 *   读到就会看见成本凭空归零。
 * - 带用户手填字段的表（卖出倍率、是否统计、采购成本…）不能删了重建，
 *   用 `parallelUpsert` 走有界并发。
 *
 * 两者都不改变落库的数值，只改写入方式。
 */

/** 有界并发：Prisma 连接池打满后反而排队变慢，也别把远端库压出连接数告警 */
const UPSERT_CONCURRENCY = 8;

/** 有界并发跑一批写操作；适用于必须保留既有字段、不能删了重建的表。 */
export async function parallelUpsert(
  ops: (() => Prisma.PrismaPromise<unknown>)[],
  concurrency = UPSERT_CONCURRENCY,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  for (let i = 0; i < ops.length; i += limit) {
    await Promise.all(ops.slice(i, i + limit).map((run) => run()));
  }
}
