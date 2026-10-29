-- DropForeignKey
ALTER TABLE "master_call_lists" DROP CONSTRAINT "master_call_lists_vin_fkey";

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "affectedAllocations" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "affectedCallListEntries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "affectedCountsComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "affectedCustomers" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "affectedRepairOrders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "affectedVehicles" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "allocationChangeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "allocationEvidenceState" TEXT NOT NULL DEFAULT 'not_started',
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "processedRows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processingStartedAt" TIMESTAMP(3),
ADD COLUMN     "recoveryBlockedReason" TEXT,
ADD COLUMN     "rollbackError" TEXT,
ADD COLUMN     "rollbackSupported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rolledBackAt" TIMESTAMP(3),
ADD COLUMN     "statsComplete" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "import_row_progress" (
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

-- CreateTable
CREATE TABLE "import_change_logs" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowProgressId" TEXT,
    "evidenceScope" TEXT NOT NULL DEFAULT 'row',
    "sequence" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
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

-- CreateIndex
CREATE INDEX "import_row_progress_importBatchId_status_idx" ON "import_row_progress"("importBatchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_progress_importBatchId_rowNumber_key" ON "import_row_progress"("importBatchId", "rowNumber");

-- CreateIndex
CREATE INDEX "import_change_logs_importBatchId_rollbackStatus_sequence_idx" ON "import_change_logs"("importBatchId", "rollbackStatus", "sequence");

-- CreateIndex
CREATE INDEX "import_change_logs_rowProgressId_idx" ON "import_change_logs"("rowProgressId");

-- CreateIndex
CREATE INDEX "import_change_logs_entityType_entityId_idx" ON "import_change_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "import_change_logs_ccmId_createdAt_idx" ON "import_change_logs"("ccmId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "import_change_logs_importBatchId_sequence_key" ON "import_change_logs"("importBatchId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_idempotencyKey_key" ON "import_batches"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "master_call_lists" ADD CONSTRAINT "master_call_lists_vin_fkey" FOREIGN KEY ("vin") REFERENCES "vehicles"("vin") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_progress" ADD CONSTRAINT "import_row_progress_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_change_logs" ADD CONSTRAINT "import_change_logs_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_change_logs" ADD CONSTRAINT "import_change_logs_rowProgressId_fkey" FOREIGN KEY ("rowProgressId") REFERENCES "import_row_progress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

