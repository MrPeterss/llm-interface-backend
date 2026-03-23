-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "origin" TEXT;

-- CreateIndex
CREATE INDEX "ApiKey_origin_idx" ON "ApiKey"("origin");
