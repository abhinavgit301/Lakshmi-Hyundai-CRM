BEGIN;

UPDATE "performance_snapshot_revisions"
SET "revision" = "revision" + 1
WHERE "scope" = 'global';

UPDATE "cre_performance_snapshots"
SET "dirtyVersion" = "dirtyVersion" + 1,
    "dirtySince" = CURRENT_TIMESTAMP,
    "status" = CASE WHEN "status" IN ('ok', 'failed') THEN 'dirty' ELSE "status" END;

COMMIT;
