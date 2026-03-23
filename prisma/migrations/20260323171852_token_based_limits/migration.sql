/*
  Warnings:

  - You are about to drop the column `limitPerHour` on the `ApiKey` table. All the data in the column will be lost.
  - You are about to drop the column `limitPerMinute` on the `ApiKey` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApiKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "limitTokensPerMinute" INTEGER,
    "limitTokensPerHour" INTEGER,
    "origin" TEXT
);
INSERT INTO "new_ApiKey" ("createdAt", "description", "id", "isActive", "key", "lastUsedAt", "limitTokensPerHour", "limitTokensPerMinute", "origin") SELECT "createdAt", "description", "id", "isActive", "key", "lastUsedAt", "limitTokensPerHour", "limitTokensPerMinute", "origin" FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "new_ApiKey" RENAME TO "ApiKey";
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");
CREATE INDEX "ApiKey_origin_idx" ON "ApiKey"("origin");
CREATE TABLE "new_ApiKeyUsageDaily" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "apiKeyId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ApiKeyUsageDaily_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApiKeyUsageDaily" ("apiKeyId", "count", "date", "id") SELECT "apiKeyId", "count", "date", "id" FROM "ApiKeyUsageDaily";
DROP TABLE "ApiKeyUsageDaily";
ALTER TABLE "new_ApiKeyUsageDaily" RENAME TO "ApiKeyUsageDaily";
CREATE INDEX "ApiKeyUsageDaily_apiKeyId_idx" ON "ApiKeyUsageDaily"("apiKeyId");
CREATE UNIQUE INDEX "ApiKeyUsageDaily_apiKeyId_date_key" ON "ApiKeyUsageDaily"("apiKeyId", "date");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
