import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { prisma } from "@/lib/db";

const ARCHIVE_STATUS = {
  preparing: "PREPARING",
  ready: "READY",
  error: "ERROR",
} as const;

const SCHEDULER_SETTING_KEY = "usageRetention:scheduler";
const SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEASE_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE_BATCH = 1_000;
const DEFAULT_DELETE_BATCH = 5_000;

export interface UsageRetentionConfig {
  rawRetentionDays: number;
  detailRetentionDays: number;
  archiveDir: string;
  archiveBatchSize: number;
  deleteBatchSize: number;
}

export interface ProviderRetentionResult {
  providerId: string;
  providerName: string;
  retired: boolean;
  archivesCompleted: number;
  rowsArchived: number;
  rawBytesArchived: number;
  archiveBytesWritten: number;
  detailRowsDeleted: number;
  deletionDeferredUntil: string | null;
}

function envInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getUsageRetentionConfig(): UsageRetentionConfig {
  const rawRetentionDays = envInt("USAGE_RAW_RETENTION_DAYS", 30, 1, 3_650);
  const detailRetentionDays = Math.max(
    rawRetentionDays,
    envInt("USAGE_DETAIL_RETENTION_DAYS", 90, 1, 3_650),
  );
  return {
    rawRetentionDays,
    detailRetentionDays,
    archiveDir:
      process.env.USAGE_ARCHIVE_DIR?.trim() ||
      path.join(
        /* turbopackIgnore: true */ process.cwd(),
        "data",
        "usage-archives",
      ),
    archiveBatchSize: envInt(
      "USAGE_ARCHIVE_BATCH_SIZE",
      DEFAULT_ARCHIVE_BATCH,
      100,
      5_000,
    ),
    deleteBatchSize: envInt(
      "USAGE_DELETE_BATCH_SIZE",
      DEFAULT_DELETE_BATCH,
      100,
      10_000,
    ),
  };
}

function subtractDays(input: Date, days: number) {
  return new Date(input.getTime() - days * 24 * 60 * 60 * 1000);
}

function addDays(input: Date, days: number) {
  return new Date(input.getTime() + days * 24 * 60 * 60 * 1000);
}

function sha256(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveUsageArchivePath(fileName: string) {
  const root = path.resolve(
    /* turbopackIgnore: true */ getUsageRetentionConfig().archiveDir,
  );
  const target = path.resolve(
    /* turbopackIgnore: true */ root,
    ...fileName.split("/"),
  );
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("归档路径越界");
  }
  return target;
}

type UsageArchiveRow = Awaited<
  ReturnType<typeof prisma.upstreamUsageLog.findMany>
>[number];

function serializeRows(rows: UsageArchiveRow[]) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function writeArchiveFile(
  fileName: string,
  content: string,
  expectedContentHash: string,
) {
  const finalPath = resolveUsageArchivePath(fileName);
  await mkdir(/* turbopackIgnore: true */ path.dirname(finalPath), {
    recursive: true,
  });

  try {
    const existing = await readFile(/* turbopackIgnore: true */ finalPath);
    const uncompressed = gunzipSync(existing);
    if (sha256(uncompressed) === expectedContentHash) {
      return existing.byteLength;
    }
    await unlink(/* turbopackIgnore: true */ finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const compressed = gzipSync(Buffer.from(content), { level: 9 });
  const tempPath = `${finalPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(/* turbopackIgnore: true */ tempPath, compressed, {
      flag: "wx",
    });
    await rename(
      /* turbopackIgnore: true */ tempPath,
      /* turbopackIgnore: true */ finalPath,
    );
  } catch (error) {
    await unlink(/* turbopackIgnore: true */ tempPath).catch(() => undefined);
    throw error;
  }
  return compressed.byteLength;
}

async function completeArchive(archiveId: string) {
  const archive = await prisma.upstreamUsageArchive.findUnique({
    where: { id: archiveId },
  });
  if (!archive || archive.status === ARCHIVE_STATUS.ready) return null;

  const rows = await prisma.upstreamUsageLog.findMany({
    where: { archiveId, archivedAt: null, raw: { not: null } },
    orderBy: [{ requestAt: "asc" }, { id: "asc" }],
  });
  if (!rows.length) {
    await prisma.upstreamUsageArchive.update({
      where: { id: archiveId },
      data: { status: ARCHIVE_STATUS.error, error: "归档批次没有可恢复的原始明细" },
    });
    return null;
  }

  const content = serializeRows(rows);
  const contentHash = sha256(content);
  const rawBytes = Buffer.byteLength(content);

  try {
    const archiveBytes = await writeArchiveFile(
      archive.fileName,
      content,
      contentHash,
    );
    const completedAt = new Date();
    await prisma.$transaction([
      prisma.upstreamUsageLog.updateMany({
        where: { archiveId, archivedAt: null, raw: { not: null } },
        data: { raw: null, archivedAt: completedAt },
      }),
      prisma.upstreamUsageArchive.update({
        where: { id: archiveId },
        data: {
          status: ARCHIVE_STATUS.ready,
          contentSha256: contentHash,
          rowCount: rows.length,
          rawBytes,
          archiveBytes,
          error: null,
          completedAt,
        },
      }),
    ]);

    return {
      rows: rows.length,
      rawBytes,
      archiveBytes,
    };
  } catch (error) {
    await prisma.upstreamUsageArchive.update({
      where: { id: archiveId },
      data: {
        status: ARCHIVE_STATUS.error,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      },
    });
    throw error;
  }
}

async function claimArchiveBatch(
  provider: { id: string; name: string },
  archiveBefore: Date,
  batchSize: number,
) {
  const candidates = await prisma.upstreamUsageLog.findMany({
    where: {
      providerId: provider.id,
      requestAt: { lt: archiveBefore },
      raw: { not: null },
      archivedAt: null,
      archiveId: null,
    },
    orderBy: [{ requestAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  if (!candidates.length) return null;

  // 每个 gzip 只覆盖一个自然月，便于审计与按月下载。
  const month = candidates[0].day.slice(0, 7);
  const rows = candidates.filter((row) => row.day.startsWith(month));
  const archiveId = randomUUID().replaceAll("-", "");
  const fileName = `${safeSegment(provider.id)}/${month}/${archiveId}.jsonl.gz`;
  const content = serializeRows(rows);
  const firstRequestAt = rows[0].requestAt;
  const lastRequestAt = rows[rows.length - 1].requestAt;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.upstreamUsageArchive.create({
        data: {
          id: archiveId,
          providerId: provider.id,
          providerName: provider.name,
          status: ARCHIVE_STATUS.preparing,
          fileName,
          contentSha256: sha256(content),
          rowCount: rows.length,
          rawBytes: Buffer.byteLength(content),
          firstRequestAt,
          lastRequestAt,
        },
      });
      const claimed = await tx.upstreamUsageLog.updateMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          archiveId: null,
          archivedAt: null,
          raw: { not: null },
        },
        data: { archiveId },
      });
      if (claimed.count !== rows.length) {
        throw new Error("归档批次被另一个维护任务抢先处理");
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("抢先处理")) {
      return null;
    }
    throw error;
  }

  return archiveId;
}

async function deleteArchivedDetails(
  providerId: string,
  deleteBefore: Date,
  batchSize: number,
  maxBatches: number,
) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await prisma.upstreamUsageLog.findMany({
      where: {
        providerId,
        requestAt: { lt: deleteBefore },
        archivedAt: { not: null },
        raw: null,
      },
      select: { id: true },
      orderBy: [{ requestAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });
    if (!rows.length) break;
    const result = await prisma.upstreamUsageLog.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += result.count;
    if (rows.length < batchSize) break;
  }
  return deleted;
}

export async function runUsageRetentionForProvider(
  providerId: string,
  opts: { now?: Date; maxArchiveBatches?: number; maxDeleteBatches?: number } = {},
): Promise<ProviderRetentionResult> {
  const config = getUsageRetentionConfig();
  const now = opts.now ?? new Date();
  const maxArchiveBatches = opts.maxArchiveBatches ?? 20;
  const maxDeleteBatches = opts.maxDeleteBatches ?? 20;
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
    select: { id: true, name: true, retiredAt: true },
  });
  if (!provider) throw new Error("上游不存在");

  const result: ProviderRetentionResult = {
    providerId,
    providerName: provider.name,
    retired: provider.retiredAt != null,
    archivesCompleted: 0,
    rowsArchived: 0,
    rawBytesArchived: 0,
    archiveBytesWritten: 0,
    detailRowsDeleted: 0,
    deletionDeferredUntil: null,
  };

  const pending = await prisma.upstreamUsageArchive.findMany({
    where: {
      providerId,
      status: { in: [ARCHIVE_STATUS.preparing, ARCHIVE_STATUS.error] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: maxArchiveBatches,
  });

  let archiveSlots = maxArchiveBatches;
  for (const archive of pending) {
    const completed = await completeArchive(archive.id);
    archiveSlots--;
    if (completed) {
      result.archivesCompleted++;
      result.rowsArchived += completed.rows;
      result.rawBytesArchived += completed.rawBytes;
      result.archiveBytesWritten += completed.archiveBytes;
    }
  }

  const archiveBefore = provider.retiredAt
    ? new Date(now.getTime() + 1)
    : subtractDays(now, config.rawRetentionDays);
  while (archiveSlots > 0) {
    const archiveId = await claimArchiveBatch(
      provider,
      archiveBefore,
      config.archiveBatchSize,
    );
    if (!archiveId) break;
    const completed = await completeArchive(archiveId);
    archiveSlots--;
    if (completed) {
      result.archivesCompleted++;
      result.rowsArchived += completed.rows;
      result.rawBytesArchived += completed.rawBytes;
      result.archiveBytesWritten += completed.archiveBytes;
    }
  }

  const retiredGraceEnd = provider.retiredAt
    ? addDays(provider.retiredAt, config.detailRetentionDays)
    : null;
  if (retiredGraceEnd && now < retiredGraceEnd) {
    result.deletionDeferredUntil = retiredGraceEnd.toISOString();
  } else {
    result.detailRowsDeleted = await deleteArchivedDetails(
      providerId,
      subtractDays(now, config.detailRetentionDays),
      config.deleteBatchSize,
      maxDeleteBatches,
    );
  }

  return result;
}

export async function getUsageRetentionStatus(providerId: string) {
  const config = getUsageRetentionConfig();
  const now = new Date();
  const provider = await prisma.upstreamProvider.findUnique({
    where: { id: providerId },
    select: { id: true, name: true, retiredAt: true },
  });
  if (!provider) throw new Error("上游不存在");

  const rawCutoff = provider.retiredAt
    ? new Date(now.getTime() + 1)
    : subtractDays(now, config.rawRetentionDays);
  const detailCutoff = subtractDays(now, config.detailRetentionDays);
  const [detailRows, rawRows, rawDue, detailDue, archiveAgg, recentArchives, schedule] =
    await Promise.all([
      prisma.upstreamUsageLog.count({ where: { providerId } }),
      prisma.upstreamUsageLog.count({ where: { providerId, raw: { not: null } } }),
      prisma.upstreamUsageLog.count({
        where: {
          providerId,
          requestAt: { lt: rawCutoff },
          raw: { not: null },
        },
      }),
      prisma.upstreamUsageLog.count({
        where: {
          providerId,
          requestAt: { lt: detailCutoff },
          archivedAt: { not: null },
          raw: null,
        },
      }),
      prisma.upstreamUsageArchive.aggregate({
        where: { providerId, status: ARCHIVE_STATUS.ready },
        _sum: { rowCount: true, rawBytes: true, archiveBytes: true },
        _count: true,
      }),
      prisma.upstreamUsageArchive.findMany({
        where: { providerId, status: ARCHIVE_STATUS.ready },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          rowCount: true,
          rawBytes: true,
          archiveBytes: true,
          firstRequestAt: true,
          lastRequestAt: true,
          createdAt: true,
        },
      }),
      prisma.appSetting.findUnique({ where: { key: SCHEDULER_SETTING_KEY } }),
    ]);

  return {
    provider,
    policy: {
      rawRetentionDays: config.rawRetentionDays,
      detailRetentionDays: config.detailRetentionDays,
    },
    online: { detailRows, rawRows, rawDue, detailDue },
    archived: {
      batches: archiveAgg._count,
      rows: archiveAgg._sum.rowCount ?? 0,
      rawBytes: archiveAgg._sum.rawBytes ?? 0,
      archiveBytes: archiveAgg._sum.archiveBytes ?? 0,
    },
    recentArchives,
    scheduler: schedule?.value ? parseSchedulerState(schedule.value) : null,
  };
}

interface SchedulerState {
  state: "idle" | "running" | "success" | "error";
  at: string;
  token?: string;
  message?: string;
}

function parseSchedulerState(value: string): SchedulerState | null {
  try {
    const parsed = JSON.parse(value) as SchedulerState;
    return parsed && typeof parsed.at === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function acquireSchedulerLease(force: boolean) {
  const idle = JSON.stringify({ state: "idle", at: new Date(0).toISOString() });
  const row = await prisma.appSetting.upsert({
    where: { key: SCHEDULER_SETTING_KEY },
    create: { key: SCHEDULER_SETTING_KEY, value: idle },
    update: {},
  });
  const current = parseSchedulerState(row.value);
  const age = current ? Date.now() - new Date(current.at).getTime() : Infinity;
  if (current?.state === "running" && age < LEASE_STALE_MS) return null;
  if (!force && current?.state === "success" && age < SCHEDULER_INTERVAL_MS) {
    return null;
  }

  const token = randomUUID();
  const lockValue = JSON.stringify({
    state: "running",
    at: new Date().toISOString(),
    token,
  });
  const claimed = await prisma.appSetting.updateMany({
    where: { key: SCHEDULER_SETTING_KEY, value: row.value },
    data: { value: lockValue },
  });
  return claimed.count === 1 ? { token, lockValue } : null;
}

export async function runScheduledUsageRetention(opts: { force?: boolean } = {}) {
  const lease = await acquireSchedulerLease(opts.force === true);
  if (!lease) return { skipped: true, results: [] as ProviderRetentionResult[] };

  try {
    const providers = await prisma.upstreamProvider.findMany({
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const results: ProviderRetentionResult[] = [];
    for (const provider of providers) {
      results.push(await runUsageRetentionForProvider(provider.id));
    }
    await prisma.appSetting.updateMany({
      where: { key: SCHEDULER_SETTING_KEY, value: lease.lockValue },
      data: {
        value: JSON.stringify({
          state: "success",
          at: new Date().toISOString(),
          providers: results.length,
          rowsArchived: results.reduce((sum, item) => sum + item.rowsArchived, 0),
          detailRowsDeleted: results.reduce(
            (sum, item) => sum + item.detailRowsDeleted,
            0,
          ),
        }),
      },
    });
    return { skipped: false, results };
  } catch (error) {
    await prisma.appSetting.updateMany({
      where: { key: SCHEDULER_SETTING_KEY, value: lease.lockValue },
      data: {
        value: JSON.stringify({
          state: "error",
          at: new Date().toISOString(),
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        }),
      },
    });
    throw error;
  }
}

declare global {
  var __orbitUsageRetentionScheduler: boolean | undefined;
}

export function startUsageRetentionScheduler() {
  if (globalThis.__orbitUsageRetentionScheduler) return;
  globalThis.__orbitUsageRetentionScheduler = true;

  const run = () => {
    void runScheduledUsageRetention().catch((error) => {
      console.error("[orbit] usage retention failed", error);
    });
  };
  const initial = setTimeout(run, 60_000);
  const interval = setInterval(run, SCHEDULER_INTERVAL_MS);
  initial.unref();
  interval.unref();
}

export async function getUsageArchiveFile(archiveId: string, providerId: string) {
  const archive = await prisma.upstreamUsageArchive.findFirst({
    where: { id: archiveId, providerId, status: ARCHIVE_STATUS.ready },
  });
  if (!archive) throw new Error("归档不存在或尚未完成");
  const filePath = resolveUsageArchivePath(archive.fileName);
  const info = await stat(/* turbopackIgnore: true */ filePath);
  if (!info.isFile()) throw new Error("归档文件不存在");
  return { archive, filePath };
}
