CREATE UNIQUE INDEX IF NOT EXISTS "vehicles_id_physicalVehicleId_key"
  ON "vehicles" ("id", "physicalVehicleId");

ALTER TABLE "free_service_milestones"
  DROP CONSTRAINT "free_service_milestones_vehicleId_fkey",
  ADD CONSTRAINT "free_service_milestones_vehicleId_physicalVehicleId_fkey"
    FOREIGN KEY ("vehicleId", "physicalVehicleId")
    REFERENCES "vehicles" ("id", "physicalVehicleId")
    ON DELETE CASCADE ON UPDATE CASCADE;
