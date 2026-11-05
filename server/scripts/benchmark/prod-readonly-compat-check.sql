-- READ-ONLY production compatibility check for the Master Call List SQL path.
-- Run on the VPS, e.g.:
--   docker exec -i lakshmi-postgres psql -U <user> -d <db> -X -v ON_ERROR_STOP=1 < prod-readonly-compat-check.sql
-- Contains only SELECT/SHOW inside a READ ONLY transaction. Prints no credentials.
BEGIN READ ONLY;

SELECT version() AS version;
SHOW timezone;
SHOW server_encoding;
SELECT datname, datcollate, datctype, datlocprovider, datcollversion FROM pg_database WHERE datname = current_database();

-- ICU collation used by the app (expected: 1 row, collprovider 'i', collversion 153.128 as in the verification container)
SELECT collname, collprovider, collversion, collisdeterministic, pg_collation_actual_version(oid) AS actual_version
FROM pg_collation WHERE collname = 'und-x-icu';
SELECT count(*) AS icu_collations FROM pg_collation WHERE collprovider = 'i';

-- Ordering behaviour must be ICU, not C (expected: icu_a_lt_B = true, c_a_lt_B = false)
SELECT ('a' COLLATE "und-x-icu" < 'B' COLLATE "und-x-icu") AS icu_a_lt_b,
       ('a' COLLATE "C" < 'B' COLLATE "C") AS c_a_lt_b;

-- Timezone names the app may send (resolver prefers WORKSHOP_TIMEZONE, then Node's canonical name)
SELECT n AS candidate, EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = n) AS recognised
FROM unnest(ARRAY['Asia/Kolkata','Asia/Calcutta','UTC','Etc/UTC']) AS n;

-- Same instant converted by both aliases must agree (errors out if an alias is unknown; that is informative too)
SELECT (TIMESTAMPTZ '2026-01-15 18:30:00+00' AT TIME ZONE 'Asia/Kolkata') AS kolkata_local;

-- Stored date convention (counts only, no customer data). Time-of-day of visitDate/saleDate in UTC:
--   18:30:00 = IST midnight written by an importer running with TZ=Asia/Kolkata
--   00:00:00 = UTC midnight (importer ran with TZ=UTC, or ISO date-only input)
SELECT to_char("visitDate", 'HH24:MI:SS') AS utc_time_of_day, count(*) AS visits
FROM workshop_visits WHERE "visitDate" IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
SELECT to_char("saleDate", 'HH24:MI:SS') AS utc_time_of_day, count(*) AS vehicles
FROM vehicles WHERE "saleDate" IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

ROLLBACK;
