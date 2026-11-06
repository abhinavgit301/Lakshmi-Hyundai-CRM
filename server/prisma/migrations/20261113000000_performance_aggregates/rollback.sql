-- Manual rollback for 20261113000000_performance_aggregates. Turn PERFORMANCE_AGGREGATES_ENABLED off first.
-- The tables only hold derived data, so dropping them loses nothing that cannot be rebuilt from source rows.
BEGIN;
DROP TABLE IF EXISTS "cre_performance_snapshots";
DROP TABLE IF EXISTS "cre_call_daily";
COMMIT;
