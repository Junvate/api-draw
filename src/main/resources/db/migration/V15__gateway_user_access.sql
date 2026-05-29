CREATE TABLE IF NOT EXISTS "GatewayUserAccess" (
  "gatewayId" TEXT NOT NULL REFERENCES "Gateway"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("gatewayId", "userId")
);

CREATE INDEX IF NOT EXISTS "GatewayUserAccess_userId_gatewayId_idx"
  ON "GatewayUserAccess"("userId", "gatewayId");
