ALTER TABLE "import_batches"
  ADD COLUMN IF NOT EXISTS "ccmId" TEXT;

WITH batch_ccms AS (
  SELECT "importBatchId", MIN("ccmId") AS "ccmId"
  FROM (
    SELECT DISTINCT "importBatchId", "ccmId"
    FROM "import_change_logs"
    WHERE "ccmId" IS NOT NULL
  ) AS distinct_batch_ccms
  GROUP BY "importBatchId"
  HAVING COUNT(*) = 1
)
UPDATE "import_batches" AS batch
SET "ccmId" = batch_ccms."ccmId"
FROM batch_ccms
WHERE batch.id = batch_ccms."importBatchId"
  AND batch."ccmId" IS NULL;

UPDATE "import_batches" AS batch
SET "ccmId" = importer."ccmId"
FROM "users" AS importer
WHERE batch."importedByUserId" = importer.id
  AND importer.role = 'CCM'
  AND importer."ccmId" IS NOT NULL
  AND batch."ccmId" IS NULL;

CREATE INDEX IF NOT EXISTS "import_batches_ccmId_createdAt_idx"
  ON "import_batches" ("ccmId", "createdAt");
