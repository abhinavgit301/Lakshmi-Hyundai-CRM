-- Backfill only a unique vehicle + normalized repair-order match. Existing
-- ambiguous or unmatched milestone references remain untouched for review.
BEGIN;

CREATE UNIQUE INDEX "workshop_visits_id_vehicleId_key"
  ON "workshop_visits" ("id", "vehicleId");

ALTER TABLE "free_service_milestones"
  ADD COLUMN "completedByWorkshopVisitId" TEXT;

UPDATE "free_service_milestones" AS milestone
SET "completedByWorkshopVisitId" = (
  SELECT visit."id"
  FROM "workshop_visits" AS visit
  WHERE visit."vehicleId" = milestone."vehicleId"
    AND visit."normalizedRepairOrderNo" =
      UPPER(BTRIM(REGEXP_REPLACE(milestone."completedByRepairOrderNo", '[[:space:]]+', ' ', 'g')))
  LIMIT 1
)
WHERE milestone."completedByRepairOrderNo" IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM "workshop_visits" AS visit
    WHERE visit."vehicleId" = milestone."vehicleId"
      AND visit."normalizedRepairOrderNo" =
        UPPER(BTRIM(REGEXP_REPLACE(milestone."completedByRepairOrderNo", '[[:space:]]+', ' ', 'g')))
  ) = 1;

ALTER TABLE "free_service_milestones"
  ADD CONSTRAINT "free_service_milestones_completedByWorkshopVisitId_vehicle_fkey"
  FOREIGN KEY ("completedByWorkshopVisitId", "vehicleId")
  REFERENCES "workshop_visits" ("id", "vehicleId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE INDEX "free_service_milestones_completedByWorkshopVisitId_idx"
  ON "free_service_milestones" ("completedByWorkshopVisitId");

COMMIT;

-- Manual rollback only: drop the milestone index and FK, drop the new milestone
-- reference column, then drop the composite visit index. The old repair-order
-- text is retained and is not modified by this migration.
