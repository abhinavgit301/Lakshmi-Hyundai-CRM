import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('projection migration creates only an empty constrained staging table', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  const sql = await readFile(new URL('../prisma/migrations/20261119000000_cre_vehicle_assignment_projection/migration.sql', import.meta.url), 'utf8');
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA projection_migration_fixture');
    await client.query('SET LOCAL search_path TO projection_migration_fixture');
    await client.query(sql);
    const empty = await client.query('SELECT COUNT(*)::int AS count FROM cre_vehicle_assignment_projection');
    assert.equal(empty.rows[0].count, 0);
    await client.query(`INSERT INTO cre_vehicle_assignment_projection VALUES ('team', 'cre', 'vehicle', TRUE, FALSE)`);
    await client.query('SAVEPOINT before_invalid');
    await assert.rejects(client.query(`INSERT INTO cre_vehicle_assignment_projection VALUES ('team', 'cre', 'other', FALSE, FALSE)`),
      (error) => error.code === '23514');
    await client.query('ROLLBACK TO SAVEPOINT before_invalid');
    await assert.rejects(client.query(`INSERT INTO cre_vehicle_assignment_projection VALUES ('team', 'cre', 'vehicle', TRUE, TRUE)`),
      (error) => error.code === '23505');
    await client.query('ROLLBACK TO SAVEPOINT before_invalid');
    const indexes = await client.query(`SELECT COUNT(*)::int AS count FROM pg_indexes WHERE schemaname = 'projection_migration_fixture' AND tablename = 'cre_vehicle_assignment_projection'`);
    assert.equal(indexes.rows[0].count, 2);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
