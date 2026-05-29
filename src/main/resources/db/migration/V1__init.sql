DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('user', 'admin');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "ApiKeyStatus" AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "GatewayProvider" AS ENUM ('openai', 'fal');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "GatewayHealth" AS ENUM ('unknown', 'healthy', 'degraded', 'down');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "ImageTaskStatus" AS ENUM ('queued', 'processing', 'success', 'failed', 'blocked', 'timeout', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "WalletEntryReason" AS ENUM ('seed', 'signup_bonus', 'admin_adjust', 'generation_hold', 'generation_refund', 'generation_settle', 'redeem_code', 'subscription_purchase');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "Tenant" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT REFERENCES "Tenant"("id"),
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'user',
  "status" "UserStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "User_tenantId_idx" ON "User"("tenantId");
CREATE INDEX IF NOT EXISTS "User_status_idx" ON "User"("status");

CREATE TABLE IF NOT EXISTS "ApiKey" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL UNIQUE,
  "scopes" TEXT[] NOT NULL,
  "status" "ApiKeyStatus" NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ApiKey_userId_idx" ON "ApiKey"("userId");
CREATE INDEX IF NOT EXISTS "ApiKey_status_idx" ON "ApiKey"("status");

CREATE TABLE IF NOT EXISTS "Plan" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "credits" INTEGER NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "interval" TEXT NOT NULL DEFAULT 'month',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL REFERENCES "Plan"("id"),
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" "OrderStatus" NOT NULL DEFAULT 'pending',
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");

CREATE TABLE IF NOT EXISTS "Subscription" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL REFERENCES "Plan"("id"),
  "status" TEXT NOT NULL DEFAULT 'active',
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Subscription_userId_idx" ON "Subscription"("userId");
CREATE INDEX IF NOT EXISTS "Subscription_status_idx" ON "Subscription"("status");

CREATE TABLE IF NOT EXISTS "Gateway" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "provider" "GatewayProvider" NOT NULL DEFAULT 'openai',
  "baseUrl" TEXT NOT NULL,
  "apiKeyEnv" TEXT,
  "apiKeyCiphertext" TEXT,
  "healthCheckPath" TEXT NOT NULL DEFAULT '/models',
  "generationPath" TEXT NOT NULL DEFAULT '/images/generations',
  "upstreamGroup" TEXT,
  "model" TEXT NOT NULL,
  "costCredits" INTEGER NOT NULL DEFAULT 1,
  "timeoutMs" INTEGER NOT NULL DEFAULT 90000,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 1,
  "healthStatus" "GatewayHealth" NOT NULL DEFAULT 'unknown',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "disabledUntil" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastLatencyMs" INTEGER,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Gateway_enabled_priority_idx" ON "Gateway"("enabled", "priority");
CREATE INDEX IF NOT EXISTS "Gateway_healthStatus_idx" ON "Gateway"("healthStatus");

CREATE TABLE IF NOT EXISTS "ImageTask" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "apiKeyId" TEXT REFERENCES "ApiKey"("id"),
  "gatewayId" TEXT REFERENCES "Gateway"("id"),
  "requestId" TEXT,
  "model" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "negativePrompt" TEXT,
  "size" TEXT NOT NULL DEFAULT '1024x1024',
  "quality" TEXT NOT NULL DEFAULT 'auto',
  "outputFormat" TEXT NOT NULL DEFAULT 'png',
  "background" TEXT NOT NULL DEFAULT 'opaque',
  "imageCount" INTEGER NOT NULL DEFAULT 1,
  "status" "ImageTaskStatus" NOT NULL DEFAULT 'queued',
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "maxRetries" INTEGER NOT NULL DEFAULT 2,
  "costCredits" INTEGER NOT NULL DEFAULT 1,
  "latencyMs" INTEGER,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageTask_apiKeyId_requestId_key" UNIQUE ("apiKeyId", "requestId")
);
CREATE INDEX IF NOT EXISTS "ImageTask_userId_createdAt_idx" ON "ImageTask"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ImageTask_status_createdAt_idx" ON "ImageTask"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ImageTask_gatewayId_idx" ON "ImageTask"("gatewayId");

CREATE TABLE IF NOT EXISTS "ImageResult" (
  "id" TEXT PRIMARY KEY,
  "taskId" TEXT NOT NULL REFERENCES "ImageTask"("id"),
  "url" TEXT NOT NULL,
  "thumbnailUrl" TEXT,
  "storageKey" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "format" TEXT NOT NULL,
  "sizeBytes" INTEGER,
  "hash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ImageResult_taskId_idx" ON "ImageResult"("taskId");

CREATE TABLE IF NOT EXISTS "WalletEntry" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id"),
  "amount" INTEGER NOT NULL,
  "reason" "WalletEntryReason" NOT NULL,
  "refId" TEXT,
  "actorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "WalletEntry_userId_createdAt_idx" ON "WalletEntry"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "WalletEntry_refId_idx" ON "WalletEntry"("refId");

CREATE TABLE IF NOT EXISTS "UsageRecord" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "apiKeyId" TEXT,
  "taskId" TEXT NOT NULL UNIQUE REFERENCES "ImageTask"("id"),
  "model" TEXT NOT NULL,
  "imageCount" INTEGER NOT NULL,
  "costCredits" INTEGER NOT NULL,
  "latencyMs" INTEGER,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "UsageRecord_userId_createdAt_idx" ON "UsageRecord"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "UsageRecord_apiKeyId_createdAt_idx" ON "UsageRecord"("apiKeyId", "createdAt");
CREATE INDEX IF NOT EXISTS "UsageRecord_status_idx" ON "UsageRecord"("status");

CREATE TABLE IF NOT EXISTS "RedemptionCode" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "credits" INTEGER NOT NULL,
  "maxUses" INTEGER NOT NULL,
  "usedBy" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT PRIMARY KEY,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "targetId" TEXT,
  "meta" JSONB,
  "ip" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");

CREATE TABLE IF NOT EXISTS "RateLimitRule" (
  "id" TEXT PRIMARY KEY,
  "scope" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "rpm" INTEGER,
  "daily" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateLimitRule_scope_subjectId_key" UNIQUE ("scope", "subjectId")
);

CREATE TABLE IF NOT EXISTS "ModelConfig" (
  "id" TEXT PRIMARY KEY,
  "model" TEXT NOT NULL UNIQUE,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "defaultSize" TEXT NOT NULL DEFAULT '1024x1024',
  "defaultQuality" TEXT NOT NULL DEFAULT 'auto',
  "allowTransparent" BOOLEAN NOT NULL DEFAULT false,
  "allowHighQuality" BOOLEAN NOT NULL DEFAULT true,
  "maxImagesPerRequest" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
