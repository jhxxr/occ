-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UpstreamProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'NEWAPI',
    "accountEmail" TEXT,
    "accountPassword" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" DATETIME,
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
INSERT INTO "new_UpstreamProvider" ("alertThreshold", "apiKey", "baseUrl", "createdAt", "currency", "discountRate", "enabled", "id", "lastBalance", "lastConsumed", "lastError", "lastSyncAt", "name", "notes", "quotaPerDollar", "type", "updatedAt") SELECT "alertThreshold", "apiKey", "baseUrl", "createdAt", "currency", "discountRate", "enabled", "id", "lastBalance", "lastConsumed", "lastError", "lastSyncAt", "name", "notes", "quotaPerDollar", "type", "updatedAt" FROM "UpstreamProvider";
DROP TABLE "UpstreamProvider";
ALTER TABLE "new_UpstreamProvider" RENAME TO "UpstreamProvider";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
