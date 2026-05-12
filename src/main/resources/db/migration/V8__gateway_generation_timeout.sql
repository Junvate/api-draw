UPDATE "Gateway"
SET "timeoutMs" = 300000,
    "updatedAt" = now()
WHERE "id" = 'openai-primary'
  AND "timeoutMs" = 90000;
