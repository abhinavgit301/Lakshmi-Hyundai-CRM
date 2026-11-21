-- Additive, empty staging table only. It is not maintained by application writes and MUST NOT
-- be used for authorization or live reads until transactional maintenance is implemented.
CREATE TABLE "cre_vehicle_assignment_projection" (
  "ccmId" TEXT NOT NULL,
  "creId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "fromMaster" BOOLEAN NOT NULL,
  "fromAllocation" BOOLEAN NOT NULL,
  CONSTRAINT "cre_vehicle_assignment_projection_pkey" PRIMARY KEY ("ccmId", "creId", "vehicleId"),
  CONSTRAINT "cre_vehicle_assignment_projection_has_source" CHECK ("fromMaster" OR "fromAllocation")
);

CREATE INDEX "cre_vehicle_assignment_projection_vehicleId_ccmId_creId_idx"
  ON "cre_vehicle_assignment_projection" ("vehicleId", "ccmId", "creId");
