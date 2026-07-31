/**
 * 数据库集成自检：弃用核销、恢复作废、使用记录归档与清理。
 *
 * 只创建带固定测试前缀的临时数据，并在 finally 中清理。
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import "dotenv/config";
import { prisma } from "../src/lib/db.ts";
import {
  getRetirementDefaults,
  restoreProvider,
  retireProvider,
  RETIREMENT_TYPE,
} from "../src/lib/provider-lifecycle.ts";
import {
  resolveUsageArchivePath,
  runUsageRetentionForProvider,
} from "../src/lib/usage-retention.ts";

const marker = `__orbit_lifecycle_check__${randomUUID()}`;
let providerId: string | null = null;
let archivePath: string | null = null;

const initialUsageRows = await prisma.upstreamUsageLog.count();

try {
  const provider = await prisma.upstreamProvider.create({
    data: {
      name: marker,
      baseUrl: "http://127.0.0.1.invalid",
      type: "SUB2API",
      enabled: true,
      discountRate: 7.2,
      lastBalance: 3,
      lastConsumed: 10,
    },
  });
  providerId = provider.id;

  await prisma.upstreamRechargeLog.create({
    data: {
      providerId,
      paidRmb: 5,
      creditGained: 2,
      source: "manual",
      status: "confirmed",
      rechargedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const remoteId = `retention-${randomUUID()}`;
  await prisma.upstreamUsageLog.create({
    data: {
      providerId,
      remoteId,
      actualCost: 0.25,
      standardCost: 0.5,
      totalTokens: 1_000,
      requestAt: new Date("2026-01-15T12:00:00.000Z"),
      day: "2026-01-15",
      raw: JSON.stringify({ remoteId, source: "integration-check" }),
    },
  });

  const defaults = await getRetirementDefaults(providerId);
  assert.equal(defaults.balance, 3);
  assert.equal(defaults.costRate, 2.5);
  assert.equal(defaults.effectiveRateSource, "recharges");

  const retireAttempts = await Promise.allSettled([
    retireProvider(providerId, {
      type: RETIREMENT_TYPE.balanceLoss,
      day: "2026-07-31",
      note: "integration check",
    }),
    retireProvider(providerId, {
      type: RETIREMENT_TYPE.balanceLoss,
      day: "2026-07-31",
      note: "concurrent integration check",
    }),
  ]);
  const succeeded = retireAttempts.filter((item) => item.status === "fulfilled");
  const rejected = retireAttempts.filter((item) => item.status === "rejected");
  assert.equal(succeeded.length, 1);
  assert.equal(rejected.length, 1);
  const retired = succeeded[0].value;
  assert.equal(retired.writeOffRmb, 7.5);
  assert.ok(retired.writeOffEntryId);
  assert.equal(
    await prisma.operatingCostEntry.count({ where: { providerId } }),
    1,
  );

  const writeOff = await prisma.operatingCostEntry.findUniqueOrThrow({
    where: { id: retired.writeOffEntryId! },
  });
  assert.equal(Number(writeOff.amountRmb), 7.5);
  assert.equal(writeOff.status, "active");

  const afterRetire = await prisma.upstreamProvider.findUniqueOrThrow({
    where: { id: providerId },
  });
  assert.equal(afterRetire.enabled, false);
  assert.equal(afterRetire.retirementType, RETIREMENT_TYPE.balanceLoss);

  const archived = await runUsageRetentionForProvider(providerId, {
    now: new Date("2026-07-31T12:00:00.000Z"),
  });
  assert.equal(archived.rowsArchived, 1);
  assert.equal(archived.detailRowsDeleted, 0);
  assert.ok(archived.deletionDeferredUntil);

  const archive = await prisma.upstreamUsageArchive.findFirstOrThrow({
    where: { providerId },
  });
  assert.equal(archive.status, "READY");
  assert.equal(archive.rowCount, 1);
  archivePath = resolveUsageArchivePath(archive.fileName);

  const archiveText = gunzipSync(await readFile(archivePath)).toString("utf8");
  assert.match(archiveText, new RegExp(remoteId));
  assert.match(archiveText, /integration-check/);

  const onlineAfterArchive = await prisma.upstreamUsageLog.findFirstOrThrow({
    where: { providerId },
  });
  assert.equal(onlineAfterArchive.raw, null);
  assert.ok(onlineAfterArchive.archivedAt);

  const cleaned = await runUsageRetentionForProvider(providerId, {
    now: new Date("2026-11-01T12:00:00.000Z"),
  });
  assert.equal(cleaned.detailRowsDeleted, 1);
  assert.equal(
    await prisma.upstreamUsageLog.count({ where: { providerId } }),
    0,
  );

  await restoreProvider(providerId);
  const restored = await prisma.upstreamProvider.findUniqueOrThrow({
    where: { id: providerId },
  });
  assert.equal(restored.enabled, true);
  assert.equal(restored.retiredAt, null);

  const voided = await prisma.operatingCostEntry.findUniqueOrThrow({
    where: { id: retired.writeOffEntryId! },
  });
  assert.equal(voided.status, "void");

  console.log("provider lifecycle and usage retention integration check passed");
} finally {
  if (providerId) {
    await prisma.operatingCostEntry.deleteMany({ where: { providerId } });
    await prisma.upstreamProvider.deleteMany({
      where: { id: providerId, name: { startsWith: "__orbit_lifecycle_check__" } },
    });
  }
  if (archivePath) {
    await unlink(archivePath).catch(() => undefined);
    await rmdir(path.dirname(archivePath)).catch(() => undefined);
    await rmdir(path.dirname(path.dirname(archivePath))).catch(() => undefined);
  }
  assert.equal(await prisma.upstreamUsageLog.count(), initialUsageRows);
  await prisma.$disconnect();
}
