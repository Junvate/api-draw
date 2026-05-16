UPDATE "Gateway"
SET "healthStatus" = 'unknown'::"GatewayHealth",
    "consecutiveFailures" = 0,
    "disabledUntil" = NULL,
    "lastError" = NULL,
    "updatedAt" = now()
WHERE "lastError" ILIKE '%response too large%'
   OR "lastError" ILIKE '%unexpected end of JSON input%'
   OR "lastError" ILIKE '%bad_response_body%';
