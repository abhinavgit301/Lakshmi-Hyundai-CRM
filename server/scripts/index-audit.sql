-- Read-only index and query-plan audit. Run on the *_bench database only:
--   psql "$BENCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/index-audit.sql
-- Nothing here writes; EXPLAIN (without ANALYZE) does not execute the query.
SET default_transaction_read_only = on;
SELECT current_database() AS database, current_setting('default_transaction_read_only') AS read_only;

-- 1. Row counts and sizes of the tables the hot endpoints read.
SELECT relname AS table, n_live_tup AS approx_rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       pg_size_pretty(pg_relation_size(relid)) AS table_size
FROM pg_stat_user_tables
WHERE relname IN ('master_call_lists','customers','vehicles','physical_vehicles','workshop_visits',
                  'appointments','allocations','call_logs','follow_ups','users')
ORDER BY pg_total_relation_size(relid) DESC;

-- 2. Existing indexes on those tables.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('master_call_lists','customers','vehicles','physical_vehicles','workshop_visits',
                    'appointments','allocations','call_logs','follow_ups','users')
ORDER BY tablename, indexname;

-- 3. Index usage since the last stats reset (idx_scan = 0 on a bench copy proves nothing about production).
SELECT relname AS table, indexrelname AS index, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
ORDER BY relname, idx_scan;

-- 4. Sequential-scan pressure per table.
SELECT relname AS table, seq_scan, seq_tup_read, idx_scan
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC
LIMIT 15;

-- 5. Candidate query shapes (plan only). Compare the node types: Seq Scan on a large table is the signal.
EXPLAIN SELECT * FROM appointments
 WHERE "ccmId" = 'x' AND "scheduledAt" >= now() AND "scheduledAt" < now() + interval '7 days'
 ORDER BY "scheduledAt", id LIMIT 50;

EXPLAIN SELECT * FROM appointments
 WHERE "assigneeId" = 'x' AND "scheduledAt" >= now() AND "scheduledAt" < now() + interval '1 day';

EXPLAIN SELECT * FROM customers ORDER BY "createdAt" DESC, id DESC LIMIT 50;

EXPLAIN SELECT * FROM master_call_lists WHERE "vehicleId" = 'x';

EXPLAIN SELECT "physicalVehicleId", max("visitDate") FROM workshop_visits GROUP BY "physicalVehicleId";

EXPLAIN SELECT * FROM call_logs WHERE "ccmId" = 'x' AND "createdAt" >= now() - interval '1 day';

EXPLAIN SELECT * FROM follow_ups WHERE "ccmId" = 'x' AND status = 'pending';
