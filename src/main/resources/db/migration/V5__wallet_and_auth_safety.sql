CREATE UNIQUE INDEX IF NOT EXISTS "WalletEntry_generation_hold_refId_key"
  ON "WalletEntry"("refId")
  WHERE "reason" = 'generation_hold'::"WalletEntryReason";

CREATE UNIQUE INDEX IF NOT EXISTS "WalletEntry_generation_refund_refId_key"
  ON "WalletEntry"("refId")
  WHERE "reason" = 'generation_refund'::"WalletEntryReason";

CREATE UNIQUE INDEX IF NOT EXISTS "WalletEntry_redeem_code_refId_userId_key"
  ON "WalletEntry"("refId", "userId")
  WHERE "reason" = 'redeem_code'::"WalletEntryReason";
