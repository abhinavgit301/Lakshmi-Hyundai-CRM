\echo '=== Rehearsal server and database identity ==='
SELECT
  current_database() AS database_name,
  current_user AS current_user,
  session_user AS session_user,
  inet_server_addr()::text AS server_address,
  inet_server_port() AS server_port,
  current_setting('server_version') AS server_version;

\echo '=== Rehearsal role attributes and memberships ==='
DO $$
DECLARE
  role_row record;
BEGIN
  FOR role_row IN SELECT * FROM pg_roles WHERE rolname IN ('migration_login', 'runtime_login')
  LOOP
    IF NOT role_row.rolcanlogin OR role_row.rolsuper OR role_row.rolinherit OR
       role_row.rolbypassrls OR role_row.rolcreaterole OR role_row.rolcreatedb OR role_row.rolreplication OR
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role_row.oid) THEN
      RAISE EXCEPTION 'Unexpected role attributes or membership for %', role_row.rolname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('migration_login', 'runtime_login')) <> 2 THEN
    RAISE EXCEPTION 'Synthetic login roles are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND (pg_get_userbyid(n.nspowner) <> 'migration_login' OR
           has_schema_privilege('runtime_login', n.oid, 'CREATE'))
  ) THEN
    RAISE EXCEPTION 'Schema ownership or runtime CREATE privilege is incorrect';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'i', 'I')
      AND pg_get_userbyid(c.relowner) <> 'migration_login'
  ) THEN
    RAISE EXCEPTION 'An application relation or index is not migration-owned';
  END IF;
  IF to_regclass('public."_prisma_migrations"') IS NULL OR
     has_table_privilege('runtime_login', 'public."_prisma_migrations"', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Migration history is missing or accessible to the runtime login';
  END IF;
END $$;

SELECT rolname, rolsuper, rolinherit, rolbypassrls, rolcreaterole,
       rolcreatedb, rolreplication, rolcanlogin
FROM pg_roles
WHERE rolname IN ('migration_login', 'runtime_login')
ORDER BY rolname;

SELECT member.rolname AS member_role, granted.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
WHERE member.rolname IN ('migration_login', 'runtime_login')
ORDER BY member.rolname, granted.rolname;

\echo '=== Rehearsal schema and object ownership ==='
SELECT n.nspname AS schema_name,
       pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname;

SELECT n.nspname AS schema_name,
       c.relname AS object_name,
       c.relkind,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'i')
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relkind, c.relname;

\echo '=== Trigger and RLS evidence ==='
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity,
       c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY n.nspname, c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
ORDER BY schemaname, tablename, policyname;

SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       t.tgname AS trigger_name,
       p.proname AS function_name,
       pg_get_userbyid(p.proowner) AS function_owner,
       p.prosecdef AS security_definer,
       t.tgenabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY n.nspname, c.relname, t.tgname;

\echo '=== Migration history ==='
SELECT format(
  'SELECT migration_name, checksum, started_at, finished_at, rolled_back_at '
  'FROM %I.%I ORDER BY started_at, migration_name;',
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND c.relname = '_prisma_migrations'
\gexec

\echo '=== Rehearsal table row counts ==='
SELECT format(
  'SELECT %L AS table_name, count(*) AS row_count FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
\gexec

\echo '=== Rehearsal database sessions ==='
SELECT
  pid,
  usename,
  datname,
  application_name,
  client_addr,
  backend_type,
  state,
  backend_start,
  xact_start,
  query_start
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
ORDER BY usename, backend_start;
