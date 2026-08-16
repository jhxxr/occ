/**
 * Downstream data fetch with optional NewAPI MySQL binding.
 * DB first when site.dbDsn is set; fall back to Admin HTTP on any failure.
 */

import { decryptSecret } from "@/lib/crypto";
import {
  fetchDownstreamDailyUsage,
  fetchDownstreamDailyUserUsage,
  fetchDownstreamModelDaily,
  fetchDownstreamRedemptions,
  fetchDownstreamTopups,
  listDownstreamUsers,
} from "@/lib/adapters";
import type {
  DownstreamDailyUsageResult,
  DownstreamDailyUserUsageResult,
  DownstreamModelDailyResult,
  DownstreamRedemptionResult,
  DownstreamTopupResult,
  DownstreamUserListResult,
} from "@/lib/adapters/types";
import {
  dbFetchDailyUsage,
  dbFetchDailyUserUsage,
  dbFetchModelDaily,
  dbFetchRedemptions,
  dbFetchTopups,
  dbListUsers,
  detectNewApiTables,
  withNewApiDb,
} from "@/lib/newapi-db";

/** Minimal site fields needed to choose DB vs HTTP. */
export type DownstreamSiteFetch = {
  baseUrl: string;
  adminKey: string; // encrypted
  adminUserId: number | null;
  quotaPerDollar: number | null;
  excludeUserIds?: string | null;
  privateUserIds?: string | null;
  dbDsn?: string | null;
};

function parseIdList(value: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function httpInput(site: DownstreamSiteFetch) {
  return {
    baseUrl: site.baseUrl,
    adminKey: decryptSecret(site.adminKey),
    adminUserId: site.adminUserId ?? 1,
    quotaPerDollar: site.quotaPerDollar || 500_000,
    excludeUserIds: parseIdList(site.excludeUserIds),
    privateUserIds: parseIdList(site.privateUserIds),
  };
}

function plainDsn(site: DownstreamSiteFetch): string | null {
  if (!site.dbDsn) return null;
  const plain = decryptSecret(site.dbDsn);
  return plain || null;
}

/**
 * Resolve exclude/private usernames from id lists + role>=100.
 * Prefers DB users when bound.
 */
export async function resolveDownstreamUsernames(site: DownstreamSiteFetch): Promise<{
  excludeUsernames: string[];
  privateUsernames: string[];
  excludeNamesResolved: boolean;
  privateNamesResolved: boolean;
  usersResult: DownstreamUserListResult;
}> {
  const excludeUserIds = parseIdList(site.excludeUserIds);
  const privateUserIds = parseIdList(site.privateUserIds);
  const usersResult = await listDownstreamUsersForSite(site);

  let excludeUsernames: string[] = [];
  let privateUsernames: string[] = [];
  let excludeNamesResolved = excludeUserIds.length === 0;
  let privateNamesResolved = privateUserIds.length === 0;

  if (usersResult.success) {
    const wantedExclude = new Set(excludeUserIds);
    const excludeIdSet = new Set(
      usersResult.users
        .filter((u) => wantedExclude.has(u.id) || u.role >= 100)
        .map((u) => u.id),
    );
    excludeUsernames = usersResult.users
      .filter((u) => excludeIdSet.has(u.id))
      .map((u) => u.username)
      .filter(Boolean);
    excludeNamesResolved =
      excludeUserIds.length === 0 || excludeUsernames.length > 0;

    const wantedPrivate = new Set(privateUserIds);
    privateUsernames = usersResult.users
      .filter((u) => wantedPrivate.has(u.id) && !excludeIdSet.has(u.id))
      .map((u) => u.username)
      .filter(Boolean);
    privateNamesResolved =
      privateUserIds.length === 0 || privateUsernames.length > 0;
  }

  return {
    excludeUsernames,
    privateUsernames,
    excludeNamesResolved,
    privateNamesResolved,
    usersResult,
  };
}

export async function listDownstreamUsersForSite(
  site: DownstreamSiteFetch,
): Promise<DownstreamUserListResult> {
  const dsn = plainDsn(site);
  const input = httpInput(site);
  if (dsn) {
    try {
      return await withNewApiDb(dsn, async (conn) => {
        const tables = await detectNewApiTables(conn);
        if (!tables.users) {
          throw new Error("库中无 users 表");
        }
        return dbListUsers(conn, {
          quotaPerDollar: input.quotaPerDollar,
          excludeUserIds: input.excludeUserIds,
          privateUserIds: input.privateUserIds,
        });
      });
    } catch {
      /* fall through to HTTP */
    }
  }
  return listDownstreamUsers(input);
}

export async function fetchDownstreamDailyUsageForSite(
  site: DownstreamSiteFetch,
  opts: {
    startDay: string;
    endDay: string;
    excludeUsernames?: string[];
    privateUsernames?: string[];
  },
): Promise<DownstreamDailyUsageResult> {
  const dsn = plainDsn(site);
  const input = {
    ...httpInput(site),
    startDay: opts.startDay,
    endDay: opts.endDay,
    excludeUsernames: opts.excludeUsernames,
    privateUsernames: opts.privateUsernames,
  };
  if (dsn) {
    try {
      return await withNewApiDb(dsn, async (conn) => {
        const tables = await detectNewApiTables(conn);
        if (!tables.logs) {
          throw new Error("库中无 logs 表");
        }
        return dbFetchDailyUsage(conn, {
          startDay: opts.startDay,
          endDay: opts.endDay,
          excludeUsernames: opts.excludeUsernames,
          privateUsernames: opts.privateUsernames,
        });
      });
    } catch {
      /* fall through */
    }
  }
  return fetchDownstreamDailyUsage(input);
}

export async function fetchDownstreamDailyUserUsageForSite(
  site: DownstreamSiteFetch,
  opts: { startDay: string; endDay: string },
): Promise<DownstreamDailyUserUsageResult> {
  const dsn = plainDsn(site);
  const input = {
    ...httpInput(site),
    startDay: opts.startDay,
    endDay: opts.endDay,
  };
  if (dsn) {
    try {
      return await withNewApiDb(dsn, async (conn) => {
        const tables = await detectNewApiTables(conn);
        if (!tables.logs) {
          throw new Error("库中无 logs 表");
        }
        return dbFetchDailyUserUsage(conn, opts);
      });
    } catch {
      /* fall through */
    }
  }
  return fetchDownstreamDailyUserUsage(input);
}

export async function fetchDownstreamModelDailyForSite(
  site: DownstreamSiteFetch,
  opts: {
    startDay: string;
    endDay: string;
    excludeUsernames?: string[];
    privateUsernames?: string[];
  },
): Promise<DownstreamModelDailyResult> {
  const dsn = plainDsn(site);
  const input = {
    ...httpInput(site),
    startDay: opts.startDay,
    endDay: opts.endDay,
    excludeUsernames: opts.excludeUsernames,
    privateUsernames: opts.privateUsernames,
  };
  if (dsn) {
    try {
      return await withNewApiDb(dsn, async (conn) => {
        const tables = await detectNewApiTables(conn);
        if (!tables.logs) {
          throw new Error("库中无 logs 表");
        }
        return dbFetchModelDaily(conn, {
          startDay: opts.startDay,
          endDay: opts.endDay,
          excludeUsernames: opts.excludeUsernames,
          privateUsernames: opts.privateUsernames,
        });
      });
    } catch {
      /* fall through */
    }
  }
  return fetchDownstreamModelDaily(input);
}

export async function fetchDownstreamTopupsForSite(
  site: DownstreamSiteFetch,
): Promise<DownstreamTopupResult> {
  const dsn = plainDsn(site);
  const input = httpInput(site);
  if (dsn) {
    try {
      return await withNewApiDb(dsn, async (conn) => {
        const tables = await detectNewApiTables(conn);
        if (!tables.top_ups) {
          throw new Error("库中无 top_ups 表");
        }
        return dbFetchTopups(conn);
      });
    } catch {
      /* fall through */
    }
  }
  return fetchDownstreamTopups(input);
}

export async function fetchDownstreamRedemptionsForSite(
  site: DownstreamSiteFetch,
): Promise<DownstreamRedemptionResult> {
  const dsn = plainDsn(site);
  const input = httpInput(site);
  if (dsn) {
    try {
      return await withNewApiDb(dsn, async (conn) => {
        const tables = await detectNewApiTables(conn);
        if (!tables.redemptions) {
          throw new Error("库中无 redemptions 表");
        }
        return dbFetchRedemptions(conn);
      });
    } catch {
      /* fall through */
    }
  }
  return fetchDownstreamRedemptions(input);
}
