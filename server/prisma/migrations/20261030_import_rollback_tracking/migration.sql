ALTER TABLE "import_batches"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT,
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processedRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "affectedCustomers" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "affectedVehicles" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "affectedRepairOrders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "affectedCallListEntries" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "affectedAllocations" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "allocationEvidenceState" TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS "allocationChangeCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rollbackSupported" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "statsComplete" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "affectedCountsComplete" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "recoveryBlockedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "rolledBackAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rollbackError" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "import_batches_idempotencyKey_key"
  ON "import_batches" ("idempotencyKey");

CREATE TABLE IF NOT EXISTS "import_change_logs" (
  "id" TEXT NOT NULL,
  "importBatchId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "rowProgressId" TEXT,
  "evidenceScope" TEXT NOT NULL DEFAULT 'row',
  "ccmId" TEXT,
  "operation" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "rollbackStatus" TEXT NOT NULL DEFAULT 'pending',
  "rollbackError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rolledBackAt" TIMESTAMP(3),
  CONSTRAINT "import_change_logs_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_change_logs_importBatchId_fkey'
  ) THEN
    ALTER TABLE "import_change_logs"
      ADD CONSTRAINT "import_change_logs_importBatchId_fkey"
      FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "import_change_logs_importBatchId_sequence_key"
  ON "import_change_logs" ("importBatchId", "sequence");
CREATE INDEX IF NOT EXISTS "import_change_logs_importBatchId_rollbackStatus_sequence_idx"
  ON "import_change_logs" ("importBatchId", "rollbackStatus", "sequence");
CREATE INDEX IF NOT EXISTS "import_change_logs_entityType_entityId_idx"
  ON "import_change_logs" ("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "import_change_logs_ccmId_createdAt_idx"
  ON "import_change_logs" ("ccmId", "createdAt");

CREATE TABLE IF NOT EXISTS "import_row_progress" (
  "id" TEXT NOT NULL,
  "importBatchId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "outcome" TEXT,
  "mutationState" TEXT NOT NULL DEFAULT 'pending',
  "loggedChangeCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "import_row_progress_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_row_progress_importBatchId_fkey'
  ) THEN
    ALTER TABLE "import_row_progress"
      ADD CONSTRAINT "import_row_progress_importBatchId_fkey"
      FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "import_row_progress_importBatchId_rowNumber_key"
  ON "import_row_progress" ("importBatchId", "rowNumber");
CREATE INDEX IF NOT EXISTS "import_row_progress_importBatchId_status_idx"
  ON "import_row_progress" ("importBatchId", "status");

ALTER TABLE "import_row_progress"
  ADD COLUMN IF NOT EXISTS "mutationState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "loggedChangeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "import_change_logs"
  ADD COLUMN IF NOT EXISTS "rowProgressId" TEXT,
  ADD COLUMN IF NOT EXISTS "evidenceScope" TEXT NOT NULL DEFAULT 'row';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_change_logs_rowProgressId_fkey'
  ) THEN
    ALTER TABLE "import_change_logs"
      ADD CONSTRAINT "import_change_logs_rowProgressId_fkey"
      FOREIGN KEY ("rowProgressId") REFERENCES "import_row_progress"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "import_change_logs_rowProgressId_idx"
  ON "import_change_logs" ("rowProgressId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'master_call_lists_vin_fkey'
      AND conrelid = '"master_call_lists"'::regclass
  ) THEN
    ALTER TABLE "master_call_lists" DROP CONSTRAINT "master_call_lists_vin_fkey";
  END IF;
  ALTER TABLE "master_call_lists"
    ADD CONSTRAINT "master_call_lists_vin_fkey"
    FOREIGN KEY ("vin") REFERENCES "vehicles"("vin")
    ON DELETE RESTRICT ON UPDATE CASCADE;
END $$;
