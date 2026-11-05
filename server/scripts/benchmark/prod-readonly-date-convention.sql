-- READ-ONLY follow-up: what do the UTC-midnight dates represent? Counts and buckets only; no customer data.
--   docker exec -i lakshmi-postgres psql -U <user> -d <db> -X -v ON_ERROR_STOP=1 < prod-readonly-date-convention.sql
BEGIN READ ONLY;

-- A. Denominator and full time-of-day distribution (UTC). 00:00:00 = UTC midnight, 18:30:00 = IST midnight.
SELECT count(*) AS visits_total, count("visitDate") AS visits_with_date,
       count(*) FILTER (WHERE "visitDate" IS NOT NULL AND "visitDate"::time = '00:00:00') AS utc_midnight,
       count(*) FILTER (WHERE "visitDate" IS NOT NULL AND "visitDate"::time = '18:30:00') AS ist_midnight,
       count(*) FILTER (WHERE "visitDate" IS NOT NULL AND "visitDate"::time NOT IN ('00:00:00','18:30:00')) AS other_time
FROM workshop_visits;
SELECT count(*) AS vehicles_total, count("saleDate") AS with_sale_date,
       count(*) FILTER (WHERE "saleDate"::time = '00:00:00') AS utc_midnight,
       count(*) FILTER (WHERE "saleDate"::time = '18:30:00') AS ist_midnight,
       count(*) FILTER (WHERE "saleDate" IS NOT NULL AND "saleDate"::time NOT IN ('00:00:00','18:30:00')) AS other_time
FROM vehicles;

-- B. Did the convention change over time? Bucket by the month the row was created.
SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS created_month,
       count(*) FILTER (WHERE "visitDate"::time = '00:00:00') AS utc_midnight,
       count(*) FILTER (WHERE "visitDate"::time = '18:30:00') AS ist_midnight,
       count(*) FILTER (WHERE "visitDate" IS NOT NULL AND "visitDate"::time NOT IN ('00:00:00','18:30:00')) AS other_time
FROM workshop_visits GROUP BY 1 ORDER BY 1;

-- C. Do the two conventions both appear within a single import batch? (needs importBatchId or similar; skipped if absent)
-- SELECT "importBatchId", count(*) FILTER (WHERE "visitDate"::time='00:00:00') AS utc, count(*) FILTER (WHERE "visitDate"::time='18:30:00') AS ist
-- FROM workshop_visits GROUP BY 1 HAVING count(*) FILTER (WHERE "visitDate"::time='00:00:00') > 0 AND count(*) FILTER (WHERE "visitDate"::time='18:30:00') > 0 LIMIT 20;

-- D. Calendar-day safety: no value should be at a time where the IST calendar day differs from the UTC day by more than the
--    midnight cases above. Rows in 00:00:00..18:29:59 UTC share the same IST day; 18:30:00..23:59:59 roll to the next IST day.
SELECT count(*) AS visits_whose_ist_day_differs_from_utc_day
FROM workshop_visits WHERE "visitDate" IS NOT NULL AND "visitDate"::time >= '18:30:00';

ROLLBACK;
