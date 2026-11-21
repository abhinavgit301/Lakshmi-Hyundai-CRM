BEGIN;

-- This derived field has no application reader. Dropping the column takes an
-- ACCESS EXCLUSIVE lock on physical_vehicles; deploy only after reviewing lock
-- wait/duration on a representative database and scheduling an approved window.
DROP TRIGGER IF EXISTS "workshop_visits_refresh_last_service_date" ON "workshop_visits";
DROP FUNCTION IF EXISTS refresh_physical_vehicle_last_service_date();
DROP INDEX IF EXISTS "physical_vehicles_lastServiceDate_idx";
ALTER TABLE "physical_vehicles" DROP COLUMN IF EXISTS "lastServiceDate";

COMMIT;
