BEGIN;

ALTER TABLE "master_call_lists"
  ADD COLUMN "assignmentNeedsReview" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "cre_assignment_history" (
  "id" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "allocationId" TEXT,
  "masterCallListId" TEXT,
  "ccmId" TEXT NOT NULL,
  "previousCreId" TEXT,
  "newCreId" TEXT,
  "actorUserId" TEXT,
  "reason" TEXT,
  "eventType" TEXT NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cre_assignment_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cre_assignment_history_entity_reference_check"
    CHECK ("allocationId" IS NOT NULL OR "masterCallListId" IS NOT NULL),
  CONSTRAINT "cre_assignment_history_eventType_check"
    CHECK ("eventType" IN ('ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'AUTO_ASSIGNED', 'DEACTIVATED', 'IMPORT_ROLLBACK')),
  CONSTRAINT "cre_assignment_history_previousCreId_fkey"
    FOREIGN KEY ("previousCreId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cre_assignment_history_newCreId_fkey"
    FOREIGN KEY ("newCreId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cre_assignment_history_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "cre_assignment_history_vehicleId_effectiveAt_idx"
  ON "cre_assignment_history"("vehicleId", "effectiveAt");
CREATE INDEX "cre_assignment_history_ccmId_effectiveAt_idx"
  ON "cre_assignment_history"("ccmId", "effectiveAt");
CREATE INDEX "cre_assignment_history_allocationId_effectiveAt_idx"
  ON "cre_assignment_history"("allocationId", "effectiveAt");
CREATE INDEX "cre_assignment_history_masterCallListId_effectiveAt_idx"
  ON "cre_assignment_history"("masterCallListId", "effectiveAt");

CREATE FUNCTION prevent_cre_assignment_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CRE assignment history is append-only.';
END;
$$;

CREATE TRIGGER "cre_assignment_history_append_only"
  BEFORE UPDATE OR DELETE ON "cre_assignment_history"
  FOR EACH ROW EXECUTE FUNCTION prevent_cre_assignment_history_mutation();

CREATE TRIGGER "cre_assignment_history_no_truncate"
  BEFORE TRUNCATE ON "cre_assignment_history"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_cre_assignment_history_mutation();

COMMIT;

-- Manual rollback: drop both triggers and the function, then drop
-- cre_assignment_history and master_call_lists.assignmentNeedsReview.
-- This discards assignment history and must only be done with explicit approval.
