ALTER TABLE "import_batches"
  ADD COLUMN "importType" TEXT NOT NULL DEFAULT 'repair_order',
  ADD COLUMN "affectedMonthlyEntries" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "monthly_customer_data_imports"
  ADD COLUMN "importBatchId" TEXT;

CREATE UNIQUE INDEX "monthly_customer_data_imports_importBatchId_key"
  ON "monthly_customer_data_imports" ("importBatchId");

ALTER TABLE "monthly_customer_data_imports"
  ADD CONSTRAINT "monthly_customer_data_imports_importBatchId_fkey"
  FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
