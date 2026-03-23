-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "limitTokensPerHour" INTEGER;
ALTER TABLE "ApiKey" ADD COLUMN "limitTokensPerMinute" INTEGER;

-- AlterTable
ALTER TABLE "ApiKeyRequest" ADD COLUMN "totalTokens" INTEGER;
