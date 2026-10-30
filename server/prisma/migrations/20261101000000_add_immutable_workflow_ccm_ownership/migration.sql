-- Historical calls and follow-ups are intentionally left unowned. Ownership is
-- recorded only for writes made after this migration is applied.
ALTER TABLE "call_logs"
  ADD COLUMN IF NOT EXISTS "ccmId" TEXT;

ALTER TABLE "follow_ups"
  ADD COLUMN IF NOT EXISTS "ccmId" TEXT;

CREATE INDEX IF NOT EXISTS "call_logs_ccmId_createdAt_idx"
  ON "call_logs" ("ccmId", "createdAt");

CREATE INDEX IF NOT EXISTS "follow_ups_ccmId_source_status_idx"
  ON "follow_ups" ("ccmId", "source", "status");
