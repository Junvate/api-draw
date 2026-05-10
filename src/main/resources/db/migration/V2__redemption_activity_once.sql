ALTER TABLE "RedemptionCode"
  ADD COLUMN IF NOT EXISTS "activityKey" TEXT;

UPDATE "RedemptionCode"
SET "activityKey" = "code"
WHERE "activityKey" IS NULL OR trim("activityKey") = '';

ALTER TABLE "RedemptionCode"
  ALTER COLUMN "activityKey" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "RedemptionCode_activityKey_idx" ON "RedemptionCode"("activityKey");

CREATE TABLE IF NOT EXISTS "RedemptionUse" (
  "id" TEXT PRIMARY KEY,
  "codeId" TEXT NOT NULL REFERENCES "RedemptionCode"("id"),
  "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "activityKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RedemptionUse_codeId_userId_key" UNIQUE ("codeId", "userId"),
  CONSTRAINT "RedemptionUse_activityKey_userId_key" UNIQUE ("activityKey", "userId")
);

CREATE INDEX IF NOT EXISTS "RedemptionUse_codeId_idx" ON "RedemptionUse"("codeId");
CREATE INDEX IF NOT EXISTS "RedemptionUse_userId_createdAt_idx" ON "RedemptionUse"("userId", "createdAt");

INSERT INTO "RedemptionUse" ("id", "codeId", "userId", "activityKey", "createdAt")
SELECT
  'ru_' || md5(c."id" || ':' || used.user_id),
  c."id",
  used.user_id,
  c."activityKey",
  c."updatedAt"
FROM "RedemptionCode" c
CROSS JOIN LATERAL unnest(c."usedBy") AS used(user_id)
ON CONFLICT DO NOTHING;
