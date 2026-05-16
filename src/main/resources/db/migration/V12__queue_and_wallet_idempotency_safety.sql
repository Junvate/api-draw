ALTER TABLE "ImageTask" DROP CONSTRAINT IF EXISTS "ImageTask_apiKeyId_requestId_key";
DROP INDEX IF EXISTS "ImageTask_apiKeyId_requestId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ImageTask_apiKeyId_requestId_present_key"
  ON "ImageTask"("apiKeyId", "requestId")
  WHERE "apiKeyId" IS NOT NULL AND "requestId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ImageTask_pending_createdAt_idx"
  ON "ImageTask"("createdAt")
  WHERE "status" IN ('queued'::"ImageTaskStatus", 'processing'::"ImageTaskStatus");
