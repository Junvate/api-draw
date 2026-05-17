ALTER TABLE "RedemptionUse"
  DROP CONSTRAINT IF EXISTS "RedemptionUse_codeId_fkey";

ALTER TABLE "RedemptionUse"
  ALTER COLUMN "codeId" DROP NOT NULL;

ALTER TABLE "RedemptionUse"
  ADD CONSTRAINT "RedemptionUse_codeId_fkey"
  FOREIGN KEY ("codeId") REFERENCES "RedemptionCode"("id") ON DELETE SET NULL;
