\echo '=== Phase 7 read-only DBA evidence ==='
BEGIN TRANSACTION READ ONLY;

\echo '=== Database and server identity ==='
SELECT
  current_database() AS database_name,
  current_user AS current_user,
  session_user AS session_user,
  inet_server_addr()::text AS server_address,
  inet_server_port() AS server_port,
  current_setting('server_version') AS server_version,
  pg_postmaster_start_time() AS postmaster_start_time;

\echo '=== Role attributes ==='
SELECT
  rolname,
  rolsuper,
  rolinherit,
  rolbypassrls,
  rolcreaterole,
  rolcreatedb,
  rolreplication,
  rolcanlogin,
  rolconnlimit,
  rolvaliduntil
FROM pg_roles
ORDER BY rolname;

\echo '=== Direct role memberships ==='
SELECT
  member.rolname AS member_role,
  granted.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles member ON member.oid = m.member
JOIN pg_roles granted ON granted.oid = m.roleid
ORDER BY member.rolname, granted.rolname;

\echo '=== Indirect role memberships ==='
WITH RECURSIVE memberships(member_oid, role_oid, path) AS (
  SELECT member, roleid, ARRAY[roleid]
  FROM pg_auth_members
  UNION ALL
  SELECT m.member, m.roleid, memberships.path || m.roleid
  FROM pg_auth_members m
  JOIN memberships ON m.member = memberships.role_oid
  WHERE NOT m.roleid = ANY(memberships.path)
)
SELECT DISTINCT
  member.rolname AS member_role,
  granted.rolname AS effective_role
FROM memberships
JOIN pg_roles member ON member.oid = memberships.member_oid
JOIN pg_roles granted ON granted.oid = memberships.role_oid
ORDER BY member.rolname, effective_role;

\echo '=== Application schemas and ownership ==='
SELECT
  n.nspname AS schema_name,
  pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname;

\echo '=== Tables, partitioned tables, views and materialized views ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS object_name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
  END AS object_type,
  pg_get_userbyid(c.relowner) AS owner,
  c.relacl IS NULL AS uses_default_acl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm')
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname;

\echo '=== Table relation ACLs and PUBLIC privileges ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS object_name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
  END AS object_type,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
  acl.privilege_type,
  acl.is_grantable,
  c.relacl IS NULL AS uses_default_acl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(
  COALESCE(c.relacl, acldefault('r', c.relowner))
) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE c.relkind IN ('r', 'p', 'v', 'm')
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname, grantee_name, acl.privilege_type;

\echo '=== Sequence ownership ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS sequence_name,
  pg_get_userbyid(c.relowner) AS owner,
  c.relacl IS NULL AS uses_default_acl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S'
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname;

\echo '=== Sequence ACLs and PUBLIC privileges ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS sequence_name,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
  acl.privilege_type,
  acl.is_grantable,
  c.relacl IS NULL AS uses_default_acl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(
  COALESCE(c.relacl, acldefault('S', c.relowner))
) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE c.relkind = 'S'
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname, grantee_name, acl.privilege_type;

\echo '=== Schema ACLs and PUBLIC privileges ==='
SELECT
  n.nspname AS schema_name,
  pg_get_userbyid(n.nspowner) AS owner,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
  acl.privilege_type,
  acl.is_grantable,
  n.nspacl IS NULL AS uses_default_acl
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(
  COALESCE(n.nspacl, acldefault('n', n.nspowner))
) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, grantee_name, acl.privilege_type;

\echo '=== Function ownership and execution mode ==='
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  p.provolatile AS volatility,
  p.proleakproof AS leakproof
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, p.proname;

\echo '=== Function ACLs and PUBLIC privileges ==='
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
  acl.privilege_type,
  acl.is_grantable,
  p.proacl IS NULL AS uses_default_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(
  COALESCE(p.proacl, acldefault('f', p.proowner))
) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, p.proname, grantee_name;

\echo '=== Type ownership and ACLs ==='
SELECT
  n.nspname AS schema_name,
  t.typname AS type_name,
  pg_get_userbyid(t.typowner) AS owner,
  CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
  acl.privilege_type,
  acl.is_grantable,
  t.typacl IS NULL AS uses_default_acl
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
CROSS JOIN LATERAL aclexplode(
  COALESCE(t.typacl, acldefault('T', t.typowner))
) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, t.typname, grantee_name;

\echo '=== Default privileges ==='
SELECT
  pg_get_userbyid(d.defaclrole) AS owner_role,
  n.nspname AS schema_name,
  CASE d.defaclobjtype
    WHEN 'r' THEN 'table'
    WHEN 'S' THEN 'sequence'
    WHEN 'f' THEN 'function'
    WHEN 'T' THEN 'type'
    WHEN 'n' THEN 'schema'
  END AS object_type,
  d.defaclacl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY owner_role, schema_name, object_type;

\echo '=== RLS table state ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS force_rls,
  pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT LIKE 'pg_%'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname;

\echo '=== RLS policies ==='
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
ORDER BY schemaname, tablename, policyname;

\echo '=== Triggers and trigger functions ==='
SELECT
  n.nspname AS schema_name,
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
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname, t.tgname;

\echo '=== Prisma migration history objects ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS object_name,
  pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND c.relname = '_prisma_migrations';

\echo '=== Prisma migration history rows for every discovered schema ==='
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

\echo '=== Unfinished Prisma migration records for every discovered schema ==='
SELECT format(
  'SELECT * FROM %I.%I '
  'WHERE started_at IS NOT NULL '
  'AND finished_at IS NULL '
  'AND rolled_back_at IS NULL;',
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND c.relname = '_prisma_migrations'
\gexec

\echo '=== Current database sessions for DBA inventory ==='
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

COMMIT;
