BEGIN;

-- Derived column: the latest visitDate across every workshop visit of the physical vehicle.
-- Visits are shared per physical vehicle (CCM visibility comes from owning a linked vehicle, not from
-- visit.ccmId), so one value per physical vehicle matches what every CCM and CRE already sees.
ALTER TABLE "physical_vehicles"
  ADD COLUMN "lastServiceDate" TIMESTAMP(3);

UPDATE "physical_vehicles" AS physical
SET "lastServiceDate" = latest."lastServiceDate"
FROM (
  SELECT "physicalVehicleId", MAX("visitDate") AS "lastServiceDate"
  FROM "workshop_visits"
  WHERE "visitDate" IS NOT NULL
  GROUP BY "physicalVehicleId"
) AS latest
WHERE latest."physicalVehicleId" = physical."id";

CREATE INDEX "physical_vehicles_lastServiceDate_idx"
  ON "physical_vehicles" ("lastServiceDate");

-- Recalculates from the remaining visits instead of comparing with the changed row, so deleting or
-- rolling back the newest visit correctly falls back to the next latest one.
CREATE FUNCTION refresh_physical_vehicle_last_service_date()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_id TEXT;
BEGIN
  FOR affected_id IN
    SELECT DISTINCT affected.id
    FROM (VALUES
      (CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD."physicalVehicleId" END),
      (CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW."physicalVehicleId" END)
    ) AS affected(id)
    WHERE affected.id IS NOT NULL
  LOOP
    UPDATE "physical_vehicles" AS physical
    SET "lastServiceDate" = (
      SELECT MAX(visit."visitDate")
      FROM "workshop_visits" AS visit
      WHERE visit."physicalVehicleId" = affected_id
        AND visit."visitDate" IS NOT NULL
    )
    WHERE physical."id" = affected_id
      AND physical."lastServiceDate" IS DISTINCT FROM (
        SELECT MAX(visit."visitDate")
        FROM "workshop_visits" AS visit
        WHERE visit."physicalVehicleId" = affected_id
          AND visit."visitDate" IS NOT NULL
      );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "workshop_visits_refresh_last_service_date"
  AFTER INSERT OR DELETE OR UPDATE OF "visitDate", "physicalVehicleId" ON "workshop_visits"
  FOR EACH ROW EXECUTE FUNCTION refresh_physical_vehicle_last_service_date();

COMMIT;

-- Manual rollback (safe: only the derived column, trigger and function are removed, no business data):
--   DROP TRIGGER "workshop_visits_refresh_last_service_date" ON "workshop_visits";
--   DROP FUNCTION refresh_physical_vehicle_last_service_date();
--   DROP INDEX "physical_vehicles_lastServiceDate_idx";
--   ALTER TABLE "physical_vehicles" DROP COLUMN "lastServiceDate";
-- Roll back the application release first (it selects this column), then run the statements above.
-- Setting DUE_LIST_STORED_DATE_FILTER=false restores the full scan without touching the database.
