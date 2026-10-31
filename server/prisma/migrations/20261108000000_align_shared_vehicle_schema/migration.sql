DO $$
DECLARE
  unresolved_ccm_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO unresolved_ccm_count
  FROM "vehicles"
  WHERE "ccmId" IS NULL OR BTRIM("ccmId") = '';

  IF unresolved_ccm_count > 0 THEN
    RAISE EXCEPTION
      'Shared vehicle migration blocked: % vehicles have an unresolved CCM owner.',
      unresolved_ccm_count;
  END IF;
END $$;

ALTER TABLE "vehicles"
  ALTER COLUMN "ccmId" SET NOT NULL;

ALTER TABLE "free_service_milestones"
  RENAME CONSTRAINT "free_service_milestones_completedByWorkshopVisitId_physicalVehi"
  TO "free_service_milestones_completedByWorkshopVisitId_physica_fkey";
