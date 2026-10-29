-- Free Service milestones, warranty sale-date tracking, categorized calls/follow-ups.
-- Written to be re-runnable: the app normally applies the schema with `prisma db push`.

DO $$ BEGIN
  CREATE TYPE "CallSource" AS ENUM ('SERVICE', 'FREE_SERVICE', 'WARRANTY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "saleDate" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "free_service_milestones" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "milestone" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "completedByRepairOrderNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "free_service_milestones_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "call_logs"
  ADD COLUMN IF NOT EXISTS "callSource" "CallSource" NOT NULL DEFAULT 'SERVICE',
  ADD COLUMN IF NOT EXISTS "milestoneId" TEXT;

ALTER TABLE "follow_ups"
  ADD COLUMN IF NOT EXISTS "creId" TEXT,
  ADD COLUMN IF NOT EXISTS "milestoneId" TEXT,
  ADD COLUMN IF NOT EXISTS "source" "CallSource" NOT NULL DEFAULT 'SERVICE',
  ADD COLUMN IF NOT EXISTS "vehicleId" TEXT;

CREATE INDEX IF NOT EXISTS "vehicles_saleDate_idx" ON "vehicles"("saleDate");
CREATE INDEX IF NOT EXISTS "free_service_milestones_dueDate_idx" ON "free_service_milestones"("dueDate");
CREATE INDEX IF NOT EXISTS "free_service_milestones_status_dueDate_idx" ON "free_service_milestones"("status", "dueDate");
CREATE UNIQUE INDEX IF NOT EXISTS "free_service_milestones_vehicleId_milestone_key" ON "free_service_milestones"("vehicleId", "milestone");
CREATE INDEX IF NOT EXISTS "call_logs_createdById_createdAt_idx" ON "call_logs"("createdById", "createdAt");
CREATE INDEX IF NOT EXISTS "call_logs_vehicleId_callSource_idx" ON "call_logs"("vehicleId", "callSource");
CREATE INDEX IF NOT EXISTS "follow_ups_source_status_idx" ON "follow_ups"("source", "status");
CREATE INDEX IF NOT EXISTS "follow_ups_customerId_source_status_idx" ON "follow_ups"("customerId", "source", "status");

DO $$ BEGIN
  ALTER TABLE "free_service_milestones" ADD CONSTRAINT "free_service_milestones_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "free_service_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_creId_fkey" FOREIGN KEY ("creId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "free_service_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
