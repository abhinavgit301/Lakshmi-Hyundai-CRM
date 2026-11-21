-- Unlinked master call-list assignments still need an auditable ownership change.
ALTER TABLE "cre_assignment_history" ALTER COLUMN "vehicleId" DROP NOT NULL;
