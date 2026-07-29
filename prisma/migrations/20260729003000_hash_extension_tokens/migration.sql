-- Existing extension inject tokens are intentionally revoked. Plaintext tokens
-- cannot be safely transformed into one-way hashes by SQLite migration SQL.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ExtensionInjectToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "providerId" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

DROP TABLE "ExtensionInjectToken";
ALTER TABLE "new_ExtensionInjectToken" RENAME TO "ExtensionInjectToken";

CREATE UNIQUE INDEX "ExtensionInjectToken_tokenHash_key" ON "ExtensionInjectToken"("tokenHash");
CREATE INDEX "ExtensionInjectToken_providerId_idx" ON "ExtensionInjectToken"("providerId");
CREATE INDEX "ExtensionInjectToken_enabled_idx" ON "ExtensionInjectToken"("enabled");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
