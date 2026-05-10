DELETE FROM "ImageResult" existing
USING "ImageResult" newer
WHERE existing."taskId" = newer."taskId"
  AND (
    newer."createdAt" > existing."createdAt"
    OR (newer."createdAt" = existing."createdAt" AND newer."id" > existing."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "ImageResult_taskId_key" ON "ImageResult"("taskId");
