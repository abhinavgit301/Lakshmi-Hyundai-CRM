-- Manual rollback is safe only when no exact repairOrderNo occurs under
-- multiple CCMs. Verify that first; then drop the composite index, make ccmId
-- nullable, drop normalizedRepairOrderNo, and recreate the global unique index.
-- Do not automate rollback: preserving cross-CCM duplicates requires forward
-- reconciliation.

BEGIN;

DO $$
DECLARE
  unresolved_ccm_count BIGINT;
  empty_repair_order_count BIGINT;
  duplicate_pair_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO unresolved_ccm_count
  FROM "workshop_visits"
  WHERE "ccmId" IS NULL OR BTRIM("ccmId") = '';

  IF unresolved_ccm_count > 0 THEN
    RAISE EXCEPTION
      'Repair-order identity migration blocked: % workshop visits have no usable CCM owner. Reconcile them manually; ownership will not be inferred.',
      unresolved_ccm_count;
  END IF;

  SELECT COUNT(*)
  INTO empty_repair_order_count
  FROM "workshop_visits"
  WHERE BTRIM(REGEXP_REPLACE("repairOrderNo", '[[:space:]]+', ' ', 'g')) = '';

  IF empty_repair_order_count > 0 THEN
    RAISE EXCEPTION
      'Repair-order identity migration blocked: % workshop visits have an empty repair-order number.',
      empty_repair_order_count;
  END IF;

  SELECT COUNT(*)
  INTO duplicate_pair_count
  FROM (
    SELECT "ccmId", UPPER(BTRIM(REGEXP_REPLACE("repairOrderNo", '[[:space:]]+', ' ', 'g')))
    FROM "workshop_visits"
    GROUP BY "ccmId", UPPER(BTRIM(REGEXP_REPLACE("repairOrderNo", '[[:space:]]+', ' ', 'g')))
    HAVING COUNT(*) > 1
  ) AS duplicate_pairs;

  IF duplicate_pair_count > 0 THEN
    RAISE EXCEPTION
      'Repair-order identity migration blocked: % CCM/normalized repair-order pairs are duplicated. Review and reconcile each pair manually.',
      duplicate_pair_count;
  END IF;
END $$;

ALTER TABLE "workshop_visits"
  ADD COLUMN "normalizedRepairOrderNo" TEXT;

UPDATE "workshop_visits"
SET "normalizedRepairOrderNo" = UPPER(BTRIM(REGEXP_REPLACE("repairOrderNo", '[[:space:]]+', ' ', 'g')));

ALTER TABLE "workshop_visits"
  ALTER COLUMN "normalizedRepairOrderNo" SET NOT NULL,
  ALTER COLUMN "ccmId" SET NOT NULL;

ALTER TABLE "workshop_visits"
  DROP CONSTRAINT IF EXISTS "workshop_visits_repairOrderNo_key";

DROP INDEX IF EXISTS "workshop_visits_repairOrderNo_key";

CREATE UNIQUE INDEX "workshop_visits_ccmId_normalizedRepairOrderNo_key"
  ON "workshop_visits" ("ccmId", "normalizedRepairOrderNo");

COMMIT;
