import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('assignment read migration adds usable, non-unique indexes without changing data', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  const migration = await readFile(new URL('../prisma/migrations/20261120000000_assignment_read_indexes/migration.sql', import.meta.url), 'utf8');
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA assignment_indexes_fixture');
    await client.query('SET LOCAL search_path TO assignment_indexes_fixture');
    await client.query(`
      CREATE TABLE master_call_lists ("id" text, "ccmId" text, "ownerUserId" text, "createdAt" timestamp);
      CREATE TABLE allocations ("vehicleId" text, "ccmId" text, "creId" text, "status" text);
      INSERT INTO master_call_lists
      SELECT n::text, 'team-' || (n % 20), 'cre-' || (n % 100), timestamp '2025-01-01' + n * interval '1 second'
      FROM generate_series(1, 20000) n;
      INSERT INTO allocations
      SELECT 'vehicle-' || n, 'team-' || (n % 20), 'cre-' || (n % 100),
        CASE WHEN n % 3 = 0 THEN 'cancelled' ELSE 'assigned' END
      FROM generate_series(1, 20000) n;
    `);
    await client.query(migration);
    await client.query('ANALYZE master_call_lists; ANALYZE allocations; SET LOCAL enable_seqscan = off');
    const explain = async (sql, values) => JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values)).rows);
    assert.match(await explain(
      'SELECT id FROM master_call_lists WHERE "ccmId" = $1 AND "ownerUserId" = $2 ORDER BY "createdAt" DESC, id DESC LIMIT 50',
      ['team-1', 'cre-1'],
    ), /mcl_ccm_owner_created_id_idx/);
    assert.match(await explain(
      'SELECT id FROM master_call_lists WHERE "ccmId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 50',
      ['team-1'],
    ), /mcl_ccm_created_id_idx/);
    assert.match(await explain(
      'SELECT "vehicleId" FROM allocations WHERE "ccmId" = $1 AND "creId" = $2 AND status = $3',
      ['team-1', 'cre-1', 'assigned'],
    ), /allocation_ccm_cre_status_vehicle_idx/);
    assert.match(await explain(
      'SELECT "creId" FROM allocations WHERE "vehicleId" = $1 AND "ccmId" = $2 AND status = $3',
      ['vehicle-1', 'team-1', 'assigned'],
    ), /allocation_vehicle_ccm_status_cre_idx/);
    const { rows } = await client.query(`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE indisunique)::int AS unique_indexes
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'assignment_indexes_fixture'
    `);
    assert.deepEqual(rows[0], { total: 4, unique_indexes: 0 });
    const counts = await client.query('SELECT (SELECT count(*)::int FROM master_call_lists) AS masters, (SELECT count(*)::int FROM allocations) AS allocations');
    assert.deepEqual(counts.rows[0], { masters: 20000, allocations: 20000 });
    await client.query(`INSERT INTO allocations VALUES ('vehicle-1', 'team-1', 'cre-1', 'assigned')`);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
