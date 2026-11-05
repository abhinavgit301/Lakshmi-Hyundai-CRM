-- READ-ONLY schema-readiness check before deploying this application version. SELECT only, inside a READ ONLY transaction.
--   docker exec -i lakshmi-postgres psql -U <user> -d <db> -X -v ON_ERROR_STOP=1 < prod-readonly-schema-readiness.sql
BEGIN READ ONLY;

-- 1. Tables the current Prisma schema expects (any row with present = false means the schema is behind this release)
SELECT t AS expected_table, EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) AS present
FROM unnest(ARRAY['physical_vehicles','workshop_visits','master_call_lists','vehicles','allocations','free_service_milestones',
                  'import_batches','import_row_progress','import_change_logs']) AS t ORDER BY 1;

-- 2. Columns added by the most recent migrations
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'physical_vehicles' AND column_name = 'lastServiceDate')
    OR (table_name = 'workshop_visits' AND column_name IN ('physicalVehicleId','importedDetails','visitDate'))
    OR (table_name = 'vehicles' AND column_name IN ('physicalVehicleId','saleDate')))
ORDER BY 1, 2;

-- 3. lastServiceDate infrastructure (migration 20261112000000). Expected after that migration: 1 trigger, 1 function, 1 index.
SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'workshop_visits_refresh_last_service_date' AND NOT tgisinternal) AS trigger_present,
       (SELECT count(*) FROM pg_proc WHERE proname = 'refresh_physical_vehicle_last_service_date') AS function_present,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'physical_vehicles_lastServiceDate_idx') AS index_present;

-- 4. Is the stored value consistent with the visits? (0 expected; skipped with an error if the column is absent)
SELECT count(*) AS physical_vehicles_with_stale_last_service_date
FROM physical_vehicles p
WHERE p."lastServiceDate" IS DISTINCT FROM (SELECT max(w."visitDate") FROM workshop_visits w WHERE w."physicalVehicleId" = p.id AND w."visitDate" IS NOT NULL);

-- 5. Migration bookkeeping (the project documents `prisma db push`, so this table may legitimately not exist)
SELECT to_regclass('public._prisma_migrations') AS prisma_migrations_table;

ROLLBACK;
