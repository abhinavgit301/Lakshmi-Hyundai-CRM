ALTER TABLE "allocations"
ADD COLUMN IF NOT EXISTS "assignmentNeedsReview" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "cre_assignment_history"
DROP CONSTRAINT IF EXISTS "cre_assignment_history_eventType_check";

ALTER TABLE "cre_assignment_history"
ADD CONSTRAINT "cre_assignment_history_eventType_check"
CHECK ("eventType" IN (
  'ASSIGNED',
  'REASSIGNED',
  'UNASSIGNED',
  'AUTO_ASSIGNED',
  'DEACTIVATED',
  'IMPORT_ROLLBACK',
  'TRANSFERRED_PENDING_REDISTRIBUTION',
  'PENDING_REDISTRIBUTION',
  'MANUAL_REDISTRIBUTION'
));

UPDATE "allocations" AS allocation
SET "assignmentNeedsReview" = true
WHERE allocation."creId" IS NULL
  AND allocation."status" = 'assigned'
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON ("allocationId") "allocationId", "eventType", "newCreId"
      FROM "cre_assignment_history"
      WHERE "allocationId" = allocation."id"
      ORDER BY "allocationId", "effectiveAt" DESC, "id" DESC
    ) AS latest_event
    WHERE latest_event."eventType" = 'DEACTIVATED'
      AND latest_event."newCreId" IS NULL
  );
