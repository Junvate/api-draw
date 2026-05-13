CREATE TABLE IF NOT EXISTS "SensitiveWordRule" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT,
  "pattern" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SensitiveWordRule_pattern_key" ON "SensitiveWordRule"("pattern");
CREATE INDEX IF NOT EXISTS "SensitiveWordRule_enabled_idx" ON "SensitiveWordRule"("enabled");

CREATE TABLE IF NOT EXISTS "RiskAlert" (
  "id" TEXT PRIMARY KEY,
  "ruleId" TEXT REFERENCES "SensitiveWordRule"("id") ON DELETE SET NULL,
  "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "apiKeyId" TEXT REFERENCES "ApiKey"("id"),
  "requestId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'web',
  "prompt" TEXT NOT NULL,
  "matchedText" TEXT,
  "rulePattern" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "RiskAlert_userId_createdAt_idx" ON "RiskAlert"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "RiskAlert_ruleId_createdAt_idx" ON "RiskAlert"("ruleId", "createdAt");
CREATE INDEX IF NOT EXISTS "RiskAlert_status_createdAt_idx" ON "RiskAlert"("status", "createdAt");
