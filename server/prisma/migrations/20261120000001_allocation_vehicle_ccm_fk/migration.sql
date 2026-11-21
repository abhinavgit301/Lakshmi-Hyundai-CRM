BEGIN;

-- Fail before changing constraints if existing allocation ownership is inconsistent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "allocations" AS allocation
    LEFT JOIN "vehicles" AS vehicle ON vehicle."id" = allocation."vehicleId"
    WHERE vehicle."id" IS NULL
       OR vehicle."ccmId" IS DISTINCT FROM allocation."ccmId"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce allocation vehicle/CCM ownership: reconcile mismatched allocations before retrying this migration.';
  END IF;
END;
$$;

-- Replacing the single-column FK with this composite FK briefly locks both tables.
ALTER TABLE "allocations"
  DROP CONSTRAINT "allocations_vehicleId_fkey";

ALTER TABLE "allocations"
  ADD CONSTRAINT "allocations_vehicleId_ccmId_fkey"
  FOREIGN KEY ("vehicleId", "ccmId")
  REFERENCES "vehicles" ("id", "ccmId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

COMMIT;
