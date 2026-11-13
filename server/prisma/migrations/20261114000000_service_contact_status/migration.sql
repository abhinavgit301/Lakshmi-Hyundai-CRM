BEGIN;

ALTER TABLE "vehicles"
  ADD COLUMN "serviceContactStatus" TEXT,
  ADD COLUMN "serviceStatusCohort" TEXT;

ALTER TABLE "appointments"
  ADD COLUMN "serviceRequestId" TEXT;

CREATE UNIQUE INDEX "appointments_serviceRequestId_key" ON "appointments"("serviceRequestId");

COMMIT;
