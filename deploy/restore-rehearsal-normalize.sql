BEGIN;

\echo '=== Synthetic role attributes ==='
SELECT rolname, rolsuper, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb,
       rolreplication, rolcanlogin
FROM pg_roles
WHERE rolname IN ('migration_login', 'runtime_login')
ORDER BY rolname;

\echo '=== Revoke unexpected memberships ==='
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members m
    JOIN pg_roles member_role ON member_role.oid = m.member
    JOIN pg_roles granted_role ON granted_role.oid = m.roleid
    WHERE member_role.rolname IN ('migration_login', 'runtime_login')
  ) THEN
    RAISE EXCEPTION 'Unexpected membership exists before normalization';
  END IF;
END $$;

\echo '=== Reject unsupported restored objects before normalization ==='
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') THEN
    RAISE EXCEPTION 'Non-default extensions require schema-specific ownership and privilege review';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND p.prokind <> 'f'
  ) THEN
    RAISE EXCEPTION 'Non-function routines require schema-specific ownership review';
  END IF;
END $$;

\echo '=== Reassign application schema ownership ==='
DO $$
DECLARE
  schema_row record;
BEGIN
  ALTER SCHEMA public OWNER TO migration_login;
  FOR schema_row IN
    SELECT n.nspname
    FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
      AND n.nspname NOT IN ('public')
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO migration_login', schema_row.nspname);
  END LOOP;
END $$;

\echo '=== Reassign application relation ownership ==='
DO $$
DECLARE
  relation_row record;
BEGIN
  FOR relation_row IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO migration_login',
      CASE relation_row.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        ELSE 'TABLE'
      END,
      relation_row.nspname,
      relation_row.relname);
  END LOOP;
END $$;

\echo '=== Reassign function ownership ==='
DO $$
DECLARE
  function_row record;
BEGIN
  FOR function_row IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO migration_login', function_row.oid::regprocedure);
  END LOOP;
END $$;

\echo '=== Reassign type ownership ==='
DO $$
DECLARE
  type_row record;
BEGIN
  FOR type_row IN
    SELECT t.oid, t.typtype
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_class c ON c.oid = t.typrelid
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
      AND t.typtype <> 'p'
      AND (t.typrelid = 0 OR c.relkind = 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_type element WHERE element.typarray = t.oid)
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO migration_login',
      CASE WHEN type_row.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
      type_row.oid::regtype);
  END LOOP;
END $$;

\echo '=== Reassign migration history ownership ==='
DO $$
DECLARE
  history_row record;
BEGIN
  FOR history_row IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND c.relname = '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO migration_login',
      history_row.nspname,
      history_row.relname);
  END LOOP;
END $$;

\echo '=== Runtime schema and relation privileges ==='
DO $$
DECLARE
  schema_row record;
  relation_row record;
  sequence_row record;
  function_row record;
  type_row record;
BEGIN
  FOR schema_row IN
    SELECT n.nspname
    FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO runtime_login', schema_row.nspname);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM runtime_login', schema_row.nspname);
  END LOOP;

  FOR relation_row IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO runtime_login',
      relation_row.nspname, relation_row.relname);
  END LOOP;

  FOR relation_row IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm')
      AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I.%I TO runtime_login',
      relation_row.nspname, relation_row.relname);
  END LOOP;

  FOR sequence_row IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I.%I TO runtime_login',
      sequence_row.nspname, sequence_row.relname);
  END LOOP;

  FOR function_row IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO runtime_login',
      function_row.oid::regprocedure);
  END LOOP;

  FOR type_row IN
    SELECT t.oid
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_class c ON c.oid = t.typrelid
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
      AND t.typtype <> 'p'
      AND (t.typrelid = 0 OR c.relkind = 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_type element WHERE element.typarray = t.oid)
  LOOP
    EXECUTE format('GRANT USAGE ON TYPE %s TO runtime_login',
      type_row.oid::regtype);
  END LOOP;
END $$;

\echo '=== Revoke migration history access from runtime ==='
DO $$
DECLARE
  history_row record;
BEGIN
  FOR history_row IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND c.relname = '_prisma_migrations'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM runtime_login',
      history_row.nspname, history_row.relname);
  END LOOP;
END $$;

\echo '=== PUBLIC schema and object privilege normalization ==='
DO $$
DECLARE
  schema_row record;
  relation_row record;
  sequence_row record;
  function_row record;
BEGIN
  FOR schema_row IN
    SELECT n.nspname
    FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', schema_row.nspname);
  END LOOP;
END $$;

COMMIT;
