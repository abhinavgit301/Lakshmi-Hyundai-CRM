BEGIN;

CREATE TABLE IF NOT EXISTS "deleted_user_identities" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "username" TEXT,
  "role" "UserRole" NOT NULL,
  "ccmId" TEXT,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deleted_user_identities_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "allocations"
  ADD COLUMN IF NOT EXISTS "creIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "creNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "creUsernameSnapshot" TEXT;
ALTER TABLE "call_logs"
  ADD COLUMN IF NOT EXISTS "assignedToIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "assignedToNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "assignedToUsernameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUsernameSnapshot" TEXT;
ALTER TABLE "follow_ups"
  ADD COLUMN IF NOT EXISTS "creIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "creNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "creUsernameSnapshot" TEXT;
ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "assigneeIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "assigneeNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "assigneeUsernameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUsernameSnapshot" TEXT;
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "userIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "userNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "userUsernameSnapshot" TEXT;
ALTER TABLE "cre_targets"
  ADD COLUMN IF NOT EXISTS "creNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "creUsernameSnapshot" TEXT;
ALTER TABLE "monthly_customer_data_entries"
  ADD COLUMN IF NOT EXISTS "createdByIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUsernameSnapshot" TEXT;
ALTER TABLE "monthly_customer_data_imports"
  ADD COLUMN IF NOT EXISTS "importedByIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "importedByNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "importedByUsernameSnapshot" TEXT;
ALTER TABLE "monthly_customer_datasets"
  ADD COLUMN IF NOT EXISTS "ccmUserIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "ccmUserNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "ccmUserUsernameSnapshot" TEXT;

ALTER TABLE "cre_assignment_history"
  DROP CONSTRAINT IF EXISTS "cre_assignment_history_previousCreId_fkey",
  DROP CONSTRAINT IF EXISTS "cre_assignment_history_newCreId_fkey",
  DROP CONSTRAINT IF EXISTS "cre_assignment_history_actorUserId_fkey";

CREATE OR REPLACE FUNCTION "validate_cre_assignment_history_identity"() RETURNS trigger AS $$
DECLARE
  reference_id TEXT;
BEGIN
  FOREACH reference_id IN ARRAY ARRAY[NEW."previousCreId", NEW."newCreId", NEW."actorUserId"] LOOP
    IF reference_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = reference_id)
      AND NOT EXISTS (SELECT 1 FROM "deleted_user_identities" WHERE "id" = reference_id) THEN
      RAISE EXCEPTION 'CRE assignment history references an unknown user identity';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cre_assignment_history_identity_guard" ON "cre_assignment_history";
CREATE TRIGGER "cre_assignment_history_identity_guard"
  BEFORE INSERT OR UPDATE ON "cre_assignment_history"
  FOR EACH ROW EXECUTE FUNCTION "validate_cre_assignment_history_identity"();

COMMIT;
