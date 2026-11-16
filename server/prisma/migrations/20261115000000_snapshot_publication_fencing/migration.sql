BEGIN;

ALTER TABLE "cre_performance_snapshots"
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "dirtyVersion" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "globalRevision" BIGINT,
  ADD COLUMN "ccmRevision" BIGINT;

CREATE TABLE "performance_snapshot_revisions" (
  "scope" TEXT PRIMARY KEY,
  "revision" BIGINT NOT NULL DEFAULT 0
);

INSERT INTO "performance_snapshot_revisions" ("scope") VALUES ('global');

UPDATE "cre_performance_snapshots"
SET "status" = 'dirty', "dirtySince" = CURRENT_TIMESTAMP
WHERE "status" IN ('ok', 'refreshing');

COMMIT;
