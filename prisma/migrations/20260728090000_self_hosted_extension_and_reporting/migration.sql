-- AlterTable
ALTER TABLE "UpstreamProvider" ADD COLUMN "lastBusinessConsumed" REAL;

-- CreateTable
CREATE TABLE "UpstreamApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "remoteKeyId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "keyPreview" TEXT NOT NULL DEFAULT '',
    "groupId" INTEGER,
    "groupName" TEXT,
    "rateMultiplier" REAL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "countAsCost" BOOLEAN NOT NULL DEFAULT false,
    "totalActualCost" REAL NOT NULL DEFAULT 0,
    "todayActualCost" REAL NOT NULL DEFAULT 0,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UpstreamApiKey_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SelfHostedGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "remoteGroupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "platform" TEXT NOT NULL DEFAULT '',
    "sellRate" REAL NOT NULL DEFAULT 0.4,
    "track" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastOfficialCost" REAL NOT NULL DEFAULT 0,
    "todayOfficialCost" REAL NOT NULL DEFAULT 0,
    "lastRequests" INTEGER NOT NULL DEFAULT 0,
    "todayRequests" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SelfHostedGroup_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SelfHostedAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "remoteAccountId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT '',
    "accountType" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "purchaseCostRmb" REAL NOT NULL DEFAULT 0,
    "track" BOOLEAN NOT NULL DEFAULT false,
    "groupIds" TEXT NOT NULL DEFAULT '[]',
    "groupNames" TEXT NOT NULL DEFAULT '',
    "lastOfficialCost" REAL NOT NULL DEFAULT 0,
    "todayOfficialCost" REAL NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "extra" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SelfHostedAccount_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UpstreamUsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "remoteKeyId" TEXT,
    "keyName" TEXT,
    "model" TEXT,
    "groupId" INTEGER,
    "groupName" TEXT,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "standardCost" REAL NOT NULL DEFAULT 0,
    "rateMultiplier" REAL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "requestType" TEXT,
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "requestAt" DATETIME NOT NULL,
    "day" TEXT NOT NULL,
    "raw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UpstreamUsageDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "remoteKeyId" TEXT NOT NULL DEFAULT '',
    "keyName" TEXT NOT NULL DEFAULT '',
    "day" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "standardCost" REAL NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costRmb" REAL NOT NULL DEFAULT 0,
    "countAsCost" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SelfHostedGroupDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "remoteGroupId" INTEGER NOT NULL,
    "groupName" TEXT NOT NULL DEFAULT '',
    "day" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "officialCost" REAL NOT NULL DEFAULT 0,
    "actualCost" REAL NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "sellRevenueRmb" REAL NOT NULL DEFAULT 0,
    "track" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UpstreamRechargeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "paidRmb" REAL NOT NULL DEFAULT 0,
    "creditGained" REAL NOT NULL DEFAULT 0,
    "balanceBefore" REAL,
    "balanceAfter" REAL,
    "consumedBefore" REAL,
    "consumedAfter" REAL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "note" TEXT,
    "rechargedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UpstreamRechargeLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExtensionInjectToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "providerId" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DownstreamSite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "adminKey" TEXT NOT NULL,
    "adminUserId" INTEGER NOT NULL DEFAULT 1,
    "quotaPerDollar" REAL NOT NULL DEFAULT 500000,
    "revenueCurrency" TEXT NOT NULL DEFAULT 'CNY',
    "excludeUserIds" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "lastConsumed" REAL,
    "lastRevenue" REAL,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_DownstreamSite" ("adminKey", "baseUrl", "createdAt", "enabled", "id", "lastConsumed", "lastError", "lastRevenue", "lastSyncAt", "name", "notes", "updatedAt") SELECT "adminKey", "baseUrl", "createdAt", "enabled", "id", "lastConsumed", "lastError", "lastRevenue", "lastSyncAt", "name", "notes", "updatedAt" FROM "DownstreamSite";
DROP TABLE "DownstreamSite";
ALTER TABLE "new_DownstreamSite" RENAME TO "DownstreamSite";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "UpstreamApiKey_providerId_countAsCost_idx" ON "UpstreamApiKey"("providerId", "countAsCost");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamApiKey_providerId_remoteKeyId_key" ON "UpstreamApiKey"("providerId", "remoteKeyId");

-- CreateIndex
CREATE INDEX "SelfHostedGroup_providerId_track_idx" ON "SelfHostedGroup"("providerId", "track");

-- CreateIndex
CREATE UNIQUE INDEX "SelfHostedGroup_providerId_remoteGroupId_key" ON "SelfHostedGroup"("providerId", "remoteGroupId");

-- CreateIndex
CREATE INDEX "SelfHostedAccount_providerId_track_idx" ON "SelfHostedAccount"("providerId", "track");

-- CreateIndex
CREATE UNIQUE INDEX "SelfHostedAccount_providerId_remoteAccountId_key" ON "SelfHostedAccount"("providerId", "remoteAccountId");

-- CreateIndex
CREATE INDEX "UpstreamUsageLog_providerId_requestAt_idx" ON "UpstreamUsageLog"("providerId", "requestAt");

-- CreateIndex
CREATE INDEX "UpstreamUsageLog_providerId_remoteKeyId_requestAt_idx" ON "UpstreamUsageLog"("providerId", "remoteKeyId", "requestAt");

-- CreateIndex
CREATE INDEX "UpstreamUsageLog_providerId_day_idx" ON "UpstreamUsageLog"("providerId", "day");

-- CreateIndex
CREATE INDEX "UpstreamUsageLog_providerId_model_idx" ON "UpstreamUsageLog"("providerId", "model");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamUsageLog_providerId_remoteId_key" ON "UpstreamUsageLog"("providerId", "remoteId");

-- CreateIndex
CREATE INDEX "UpstreamUsageDaily_providerId_day_idx" ON "UpstreamUsageDaily"("providerId", "day");

-- CreateIndex
CREATE INDEX "UpstreamUsageDaily_providerId_countAsCost_day_idx" ON "UpstreamUsageDaily"("providerId", "countAsCost", "day");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamUsageDaily_providerId_remoteKeyId_day_key" ON "UpstreamUsageDaily"("providerId", "remoteKeyId", "day");

-- CreateIndex
CREATE INDEX "SelfHostedGroupDaily_providerId_day_idx" ON "SelfHostedGroupDaily"("providerId", "day");

-- CreateIndex
CREATE INDEX "SelfHostedGroupDaily_providerId_track_day_idx" ON "SelfHostedGroupDaily"("providerId", "track", "day");

-- CreateIndex
CREATE UNIQUE INDEX "SelfHostedGroupDaily_providerId_remoteGroupId_day_key" ON "SelfHostedGroupDaily"("providerId", "remoteGroupId", "day");

-- CreateIndex
CREATE INDEX "UpstreamRechargeLog_providerId_rechargedAt_idx" ON "UpstreamRechargeLog"("providerId", "rechargedAt");

-- CreateIndex
CREATE INDEX "UpstreamRechargeLog_providerId_status_idx" ON "UpstreamRechargeLog"("providerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionInjectToken_token_key" ON "ExtensionInjectToken"("token");

-- CreateIndex
CREATE INDEX "ExtensionInjectToken_providerId_idx" ON "ExtensionInjectToken"("providerId");

-- CreateIndex
CREATE INDEX "ExtensionInjectToken_enabled_idx" ON "ExtensionInjectToken"("enabled");
