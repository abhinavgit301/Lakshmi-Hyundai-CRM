BEGIN;

DO $$
DECLARE
  unresolved_vehicle_count BIGINT;
  duplicate_vehicle_scope_count BIGINT;
  duplicate_registration_scope_count BIGINT;
  broken_workshop_vehicle_count BIGINT;
  broken_milestone_vehicle_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO unresolved_vehicle_count
  FROM "vehicles"
  WHERE "vin" IS NULL
     OR BTRIM("vin") = ''
     OR REGEXP_REPLACE(UPPER(BTRIM("vin")), '[^A-HJ-NPR-Z0-9]', '', 'g') = ''
     OR "ccmId" IS NULL
     OR BTRIM("ccmId") = '';

  IF unresolved_vehicle_count > 0 THEN
    RAISE EXCEPTION
      'Physical vehicle migration blocked: % vehicles have a blank VIN or unresolved CCM. Reconcile ownership before migration.',
      unresolved_vehicle_count;
  END IF;

  SELECT COUNT(*)
  INTO duplicate_vehicle_scope_count
  FROM (
    SELECT REGEXP_REPLACE(UPPER(BTRIM("vin")), '[^A-HJ-NPR-Z0-9]', '', 'g'), "ccmId"
    FROM "vehicles"
    GROUP BY REGEXP_REPLACE(UPPER(BTRIM("vin")), '[^A-HJ-NPR-Z0-9]', '', 'g'), "ccmId"
    HAVING COUNT(*) > 1
  ) AS duplicate_scopes;

  IF duplicate_vehicle_scope_count > 0 THEN
    RAISE EXCEPTION
      'Physical vehicle migration blocked: % normalized VIN/CCM vehicle scopes are duplicated. Review them without deleting or merging records.',
      duplicate_vehicle_scope_count;
  END IF;

  SELECT COUNT(*)
  INTO duplicate_registration_scope_count
  FROM (
    SELECT UPPER(BTRIM("registrationNumber")), "ccmId"
    FROM "vehicles"
    WHERE "registrationNumber" IS NOT NULL AND BTRIM("registrationNumber") <> ''
    GROUP BY UPPER(BTRIM("registrationNumber")), "ccmId"
    HAVING COUNT(*) > 1
  ) AS duplicate_registrations;

  IF duplicate_registration_scope_count > 0 THEN
    RAISE EXCEPTION
      'Physical vehicle migration blocked: % normalized registration/CCM scopes are duplicated. Reconcile them before migration.',
      duplicate_registration_scope_count;
  END IF;

  SELECT COUNT(*)
  INTO broken_workshop_vehicle_count
  FROM "workshop_visits" AS visit
  LEFT JOIN "vehicles" AS vehicle ON vehicle."id" = visit."vehicleId"
  WHERE vehicle."id" IS NULL
     OR BTRIM(COALESCE(vehicle."vin", '')) = '';

  IF broken_workshop_vehicle_count > 0 THEN
    RAISE EXCEPTION
      'Physical vehicle migration blocked: % workshop visits have no usable originating vehicle/VIN.',
      broken_workshop_vehicle_count;
  END IF;

  SELECT COUNT(*)
  INTO broken_milestone_vehicle_count
  FROM "free_service_milestones" AS milestone
  LEFT JOIN "vehicles" AS vehicle ON vehicle."id" = milestone."vehicleId"
  WHERE vehicle."id" IS NULL;

  IF broken_milestone_vehicle_count > 0 THEN
    RAISE EXCEPTION
      'Physical vehicle migration blocked: % milestones have no originating vehicle.',
      broken_milestone_vehicle_count;
  END IF;
END $$;

CREATE TABLE "physical_vehicles" (
  "id" TEXT NOT NULL,
  "vin" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "physical_vehicles_pkey" PRIMARY KEY ("id")
);

INSERT INTO "physical_vehicles" ("id", "vin", "createdAt", "updatedAt")
SELECT
  'physical-' || MD5(REGEXP_REPLACE(UPPER(BTRIM(vehicle."vin")), '[^A-HJ-NPR-Z0-9]', '', 'g')),
  REGEXP_REPLACE(UPPER(BTRIM(vehicle."vin")), '[^A-HJ-NPR-Z0-9]', '', 'g'),
  MIN(vehicle."createdAt"),
  MAX(vehicle."updatedAt")
FROM "vehicles" AS vehicle
GROUP BY REGEXP_REPLACE(UPPER(BTRIM(vehicle."vin")), '[^A-HJ-NPR-Z0-9]', '', 'g');

CREATE UNIQUE INDEX "physical_vehicles_vin_key" ON "physical_vehicles" ("vin");

ALTER TABLE "vehicles"
  ADD COLUMN "physicalVehicleId" TEXT;

UPDATE "vehicles" AS vehicle
SET "physicalVehicleId" = physical."id"
FROM "physical_vehicles" AS physical
WHERE physical."vin" = REGEXP_REPLACE(UPPER(BTRIM(vehicle."vin")), '[^A-HJ-NPR-Z0-9]', '', 'g');

ALTER TABLE "vehicles"
  ALTER COLUMN "physicalVehicleId" SET NOT NULL;

ALTER TABLE "workshop_visits"
  ADD COLUMN "physicalVehicleId" TEXT;

UPDATE "workshop_visits" AS visit
SET "physicalVehicleId" = vehicle."physicalVehicleId"
FROM "vehicles" AS vehicle
WHERE vehicle."id" = visit."vehicleId";

ALTER TABLE "workshop_visits"
  ALTER COLUMN "physicalVehicleId" SET NOT NULL;

ALTER TABLE "free_service_milestones"
  ADD COLUMN "physicalVehicleId" TEXT;

UPDATE "free_service_milestones" AS milestone
SET "physicalVehicleId" = vehicle."physicalVehicleId"
FROM "vehicles" AS vehicle
WHERE vehicle."id" = milestone."vehicleId";

ALTER TABLE "free_service_milestones"
  ALTER COLUMN "physicalVehicleId" SET NOT NULL;

CREATE UNIQUE INDEX "vehicles_id_ccmId_key" ON "vehicles" ("id", "ccmId");

ALTER TABLE "master_call_lists"
  ADD COLUMN "vehicleId" TEXT;

UPDATE "master_call_lists" AS entry
SET "vehicleId" = vehicle."id"
FROM "vehicles" AS vehicle
JOIN "physical_vehicles" AS physical
  ON physical."vin" = REGEXP_REPLACE(UPPER(BTRIM(vehicle."vin")), '[^A-HJ-NPR-Z0-9]', '', 'g')
WHERE vehicle."ccmId" = entry."ccmId"
  AND physical."vin" = REGEXP_REPLACE(UPPER(BTRIM(entry."vin")), '[^A-HJ-NPR-Z0-9]', '', 'g');

ALTER TABLE "workshop_visits"
  DROP CONSTRAINT IF EXISTS "free_service_milestones_completedVisit_vehicle_fkey";

ALTER TABLE "free_service_milestones"
  DROP CONSTRAINT IF EXISTS "free_service_milestones_completedByWorkshopVisitId_vehicle_fkey";

ALTER TABLE "vehicles"
  DROP CONSTRAINT IF EXISTS "vehicles_vin_key",
  DROP CONSTRAINT IF EXISTS "vehicles_registrationNumber_key";

ALTER TABLE "master_call_lists"
  DROP CONSTRAINT IF EXISTS "master_call_lists_vin_fkey";

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_physicalVehicleId_fkey"
    FOREIGN KEY ("physicalVehicleId") REFERENCES "physical_vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workshop_visits"
  ADD CONSTRAINT "workshop_visits_physicalVehicleId_fkey"
    FOREIGN KEY ("physicalVehicleId") REFERENCES "physical_vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "workshop_visits_id_physicalVehicleId_key"
    UNIQUE ("id", "physicalVehicleId");

ALTER TABLE "free_service_milestones"
  ADD CONSTRAINT "free_service_milestones_physicalVehicleId_fkey"
    FOREIGN KEY ("physicalVehicleId") REFERENCES "physical_vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "free_service_milestones_completedByWorkshopVisitId_physicalVehicleId_fkey"
    FOREIGN KEY ("completedByWorkshopVisitId", "physicalVehicleId")
    REFERENCES "workshop_visits"("id", "physicalVehicleId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "master_call_lists"
  ADD CONSTRAINT "master_call_lists_vehicleId_ccmId_fkey"
    FOREIGN KEY ("vehicleId", "ccmId") REFERENCES "vehicles"("id", "ccmId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "vehicles_physicalVehicleId_ccmId_key" ON "vehicles" ("physicalVehicleId", "ccmId");
CREATE UNIQUE INDEX "vehicles_ccmId_registrationNumber_key" ON "vehicles" ("ccmId", "registrationNumber");
CREATE INDEX "vehicles_physicalVehicleId_idx" ON "vehicles" ("physicalVehicleId");
CREATE INDEX "workshop_visits_physicalVehicleId_idx" ON "workshop_visits" ("physicalVehicleId");
CREATE INDEX "free_service_milestones_physicalVehicleId_idx" ON "free_service_milestones" ("physicalVehicleId");
CREATE INDEX "master_call_lists_vehicleId_idx" ON "master_call_lists" ("vehicleId");

COMMIT;

-- Manual rollback requires explicit review: restore the old vehicle VIN and
-- milestone foreign keys only after resolving all cross-CCM vehicle records.
-- Do not remove physical identities or merge CCM-specific operational records.
