CREATE TABLE IF NOT EXISTS "UserWarning" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "actorId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "category" TEXT NOT NULL DEFAULT 'risk',
  "message" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "UserWarning_userId_acknowledgedAt_createdAt_idx"
  ON "UserWarning"("userId", "acknowledgedAt", "createdAt");

CREATE INDEX IF NOT EXISTS "UserWarning_createdAt_idx"
  ON "UserWarning"("createdAt");
