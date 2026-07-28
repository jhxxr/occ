-- CreateTable
CREATE TABLE "UpstreamProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'NEWAPI',
    "discountRate" REAL NOT NULL DEFAULT 7.2,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "alertThreshold" REAL NOT NULL DEFAULT 10,
    "quotaPerDollar" REAL NOT NULL DEFAULT 500000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "lastBalance" REAL,
    "lastConsumed" REAL,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DownstreamSite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "adminKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "lastConsumed" REAL,
    "lastRevenue" REAL,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SnapshotLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "upstreamId" TEXT NOT NULL,
    "balance" REAL NOT NULL,
    "consumed" REAL NOT NULL DEFAULT 0,
    "deltaConsumed" REAL NOT NULL DEFAULT 0,
    "costRmb" REAL NOT NULL DEFAULT 0,
    "raw" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SnapshotLog_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "UpstreamProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DownstreamSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "downstreamId" TEXT NOT NULL,
    "consumed" REAL NOT NULL DEFAULT 0,
    "revenue" REAL NOT NULL DEFAULT 0,
    "revenueCurrency" TEXT NOT NULL DEFAULT 'CNY',
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "raw" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DownstreamSnapshot_downstreamId_fkey" FOREIGN KEY ("downstreamId") REFERENCES "DownstreamSite" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "SnapshotLog_upstreamId_timestamp_idx" ON "SnapshotLog"("upstreamId", "timestamp");

-- CreateIndex
CREATE INDEX "SnapshotLog_timestamp_idx" ON "SnapshotLog"("timestamp");

-- CreateIndex
CREATE INDEX "DownstreamSnapshot_downstreamId_timestamp_idx" ON "DownstreamSnapshot"("downstreamId", "timestamp");

-- CreateIndex
CREATE INDEX "DownstreamSnapshot_timestamp_idx" ON "DownstreamSnapshot"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");
