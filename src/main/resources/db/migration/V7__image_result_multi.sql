DROP INDEX IF EXISTS "ImageResult_taskId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ImageResult_taskId_url_key" ON "ImageResult"("taskId", "url");
