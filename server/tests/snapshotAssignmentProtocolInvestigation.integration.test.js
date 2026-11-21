import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

async function fixture(run) {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  const clients = Array.from({ length: 3 }, () => new pg.Client({ connectionString: databaseUrl }));
  const [first, second, observer] = clients;
  const schema = `lock_probe_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    await Promise.all(clients.map((client) => client.connect()));
    await observer.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await observer.query(`CREATE TABLE "${schema}".source (id text PRIMARY KEY, vehicle text, owner text)`);
    await observer.query(`CREATE TABLE "${schema}".projection (vehicle text, owner text, PRIMARY KEY (vehicle, owner))`);
    await observer.query(`INSERT INTO "${schema}".source VALUES ('entry', 'v1', 'old')`);
    await observer.query(`INSERT INTO "${schema}".projection VALUES ('v1', 'old')`);
    await run({ first, second, observer, schema, gate: `protocol-gate:${schema}` });
  } finally {
    await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
    if (created) await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
    await Promise.all(clients.map((client) => client.end()));
  }
}

async function waitForBlock(observer, client) {
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return async () => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const { rows } = await observer.query('SELECT cardinality(pg_blocking_pids($1)) AS count', [pid]);
      if (rows[0].count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Expected PostgreSQL transaction to block.');
  };
}

test('global gate prevents the modeled source-row versus advisory inversion', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, second, observer, schema, gate }) => {
  await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
  await Promise.all([first.query("SET LOCAL lock_timeout = '4s'"), second.query("SET LOCAL lock_timeout = '4s'")]);
  const wait = await waitForBlock(observer, second);
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await first.query(`SELECT id FROM "${schema}".source WHERE id = 'entry' FOR UPDATE`);
  const waitingGate = second.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await wait();
  await first.query(`DELETE FROM "${schema}".source WHERE id = 'entry'`);
  await first.query(`DELETE FROM "${schema}".projection WHERE vehicle = 'v1'`);
  await first.query('COMMIT');
  await waitingGate;
  const current = await second.query(`SELECT * FROM "${schema}".source WHERE id = 'entry'`);
  assert.equal(current.rowCount, 0);
  await second.query('COMMIT');
  assert.equal((await observer.query(`SELECT count(*)::int AS n FROM "${schema}".projection`)).rows[0].n, 0);
}));

test('read committed revalidation detects relinking after initial discovery', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, second, observer, schema, gate }) => {
  await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const initial = (await first.query(`SELECT vehicle FROM "${schema}".source WHERE id = 'entry'`)).rows[0].vehicle;
  await second.query('BEGIN');
  await second.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await second.query(`UPDATE "${schema}".source SET vehicle = 'v2' WHERE id = 'entry'`);
  await second.query(`DELETE FROM "${schema}".projection WHERE vehicle = 'v1'`);
  await second.query(`INSERT INTO "${schema}".projection VALUES ('v2', 'old')`);
  await second.query('COMMIT');
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  const current = (await first.query(`SELECT vehicle FROM "${schema}".source WHERE id = 'entry' FOR UPDATE`)).rows[0].vehicle;
  assert.equal(initial, 'v1');
  assert.equal(current, 'v2');
  await first.query('ROLLBACK');
  await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  const rediscovered = (await first.query(`SELECT vehicle FROM "${schema}".source WHERE id = 'entry' FOR UPDATE`)).rows[0].vehicle;
  assert.equal(rediscovered, 'v2');
  await first.query(`UPDATE "${schema}".source SET owner = 'new' WHERE id = 'entry'`);
  await first.query(`UPDATE "${schema}".projection SET owner = 'new' WHERE vehicle = 'v2'`);
  await first.query('COMMIT');
  const source = (await observer.query(`SELECT vehicle, owner FROM "${schema}".source`)).rows;
  const projection = (await observer.query(`SELECT vehicle, owner FROM "${schema}".projection`)).rows;
  assert.deepEqual(projection, source);
}));

test('serializable advisory-lock wait can retain a pre-commit snapshot and require whole-transaction retry', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, second, observer, schema, gate }) => {
  await first.query('BEGIN');
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await first.query(`UPDATE "${schema}".source SET owner = 'other' WHERE id = 'entry'`);
  await first.query(`UPDATE "${schema}".projection SET owner = 'other' WHERE vehicle = 'v1'`);
  await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await second.query("SET LOCAL lock_timeout = '4s'");
  const wait = await waitForBlock(observer, second);
  const waitingGate = second.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await wait();
  await first.query('COMMIT');
  await waitingGate;
  assert.equal((await second.query(`SELECT owner FROM "${schema}".source WHERE id = 'entry'`)).rows[0].owner, 'old');
  await assert.rejects(second.query(`UPDATE "${schema}".source SET owner = 'retry' WHERE id = 'entry'`),
    (error) => error.code === '40001');
  await second.query('ROLLBACK');
  await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await second.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  assert.equal((await second.query(`SELECT owner FROM "${schema}".source WHERE id = 'entry'`)).rows[0].owner, 'other');
  await second.query(`UPDATE "${schema}".source SET owner = 'retry' WHERE id = 'entry'`);
  await second.query(`UPDATE "${schema}".projection SET owner = 'retry' WHERE vehicle = 'v1'`);
  await second.query('COMMIT');
  const source = (await observer.query(`SELECT vehicle, owner FROM "${schema}".source`)).rows;
  const projection = (await observer.query(`SELECT vehicle, owner FROM "${schema}".projection`)).rows;
  assert.deepEqual(projection, source);
}));

test('sorted overlapping vehicle locks serialize a modeled multi-vehicle update', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, second, observer, schema }) => {
  await observer.query(`INSERT INTO "${schema}".source VALUES ('entry2', 'v2', 'old')`);
  await observer.query(`INSERT INTO "${schema}".projection VALUES ('v2', 'old')`);
  const lockVehicle = (client, id) => client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`${schema}:${id}`],
  );
  await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
  await Promise.all([first.query("SET LOCAL lock_timeout = '4s'"), second.query("SET LOCAL lock_timeout = '4s'")]);
  const wait = await waitForBlock(observer, second);
  for (const id of ['v2', 'v1'].sort()) await lockVehicle(first, id);
  const secondFirstLock = lockVehicle(second, ['v2', 'v1'].sort()[0]);
  await wait();
  await first.query(`UPDATE "${schema}".source SET owner = 'first'`);
  await first.query(`UPDATE "${schema}".projection SET owner = 'first'`);
  await first.query('COMMIT');
  await secondFirstLock;
  await lockVehicle(second, 'v2');
  await second.query(`UPDATE "${schema}".source SET owner = 'second'`);
  await second.query(`UPDATE "${schema}".projection SET owner = 'second'`);
  await second.query('COMMIT');
  const source = (await observer.query(`SELECT vehicle, owner FROM "${schema}".source ORDER BY vehicle`)).rows;
  const projection = (await observer.query(`SELECT vehicle, owner FROM "${schema}".projection ORDER BY vehicle`)).rows;
  assert.deepEqual(projection, source);
  assert.deepEqual(source.map(({ owner }) => owner), ['second', 'second']);
}));

test('foreign-key insertion waits for vehicle lock and deletion respects the reference', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, second, observer, schema }) => {
  await observer.query(`CREATE TABLE "${schema}".vehicle (id text PRIMARY KEY)`);
  await observer.query(`CREATE TABLE "${schema}".linked (id text PRIMARY KEY, vehicle text REFERENCES "${schema}".vehicle(id) ON DELETE RESTRICT)`);
  await observer.query(`INSERT INTO "${schema}".vehicle VALUES ('v1')`);
  await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
  await second.query("SET LOCAL lock_timeout = '4s'");
  const wait = await waitForBlock(observer, second);
  await first.query(`SELECT id FROM "${schema}".vehicle WHERE id = 'v1' FOR UPDATE`);
  const insertion = second.query(`INSERT INTO "${schema}".linked VALUES ('entry', 'v1')`);
  await wait();
  await first.query('COMMIT');
  await insertion;
  await second.query('COMMIT');
  await assert.rejects(observer.query(`DELETE FROM "${schema}".vehicle WHERE id = 'v1'`),
    (error) => error.code === '23001');
  assert.equal((await observer.query(`SELECT count(*)::int AS n FROM "${schema}".linked`)).rows[0].n, 1);
}));

test('modeled orphan cleanup and missing-row repair roll back with source changes', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, observer, schema, gate }) => {
  await observer.query(`DELETE FROM "${schema}".projection`);
  await observer.query(`INSERT INTO "${schema}".projection VALUES ('orphan', 'old')`);
  await first.query('BEGIN');
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await first.query(`UPDATE "${schema}".source SET owner = 'new' WHERE id = 'entry'`);
  await first.query(`DELETE FROM "${schema}".projection`);
  await first.query(`INSERT INTO "${schema}".projection SELECT vehicle, owner FROM "${schema}".source`);
  await first.query('ROLLBACK');
  assert.deepEqual((await observer.query(`SELECT vehicle, owner FROM "${schema}".source`)).rows,
    [{ vehicle: 'v1', owner: 'old' }]);
  assert.deepEqual((await observer.query(`SELECT vehicle, owner FROM "${schema}".projection`)).rows,
    [{ vehicle: 'orphan', owner: 'old' }]);
  await first.query('BEGIN');
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await first.query(`DELETE FROM "${schema}".projection`);
  await first.query(`INSERT INTO "${schema}".projection SELECT vehicle, owner FROM "${schema}".source`);
  await first.query('COMMIT');
  assert.deepEqual((await observer.query(`SELECT vehicle, owner FROM "${schema}".projection`)).rows,
    [{ vehicle: 'v1', owner: 'old' }]);
}));

test('a modeled deadlock requires rollback and a complete retry without duplicate audit entries', {
  skip: !databaseUrl, timeout: 15000,
}, async () => fixture(async ({ first, second, observer, schema, gate }) => {
  await observer.query(`CREATE TABLE "${schema}".audit (id text PRIMARY KEY)`);
  await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
  await Promise.all([first.query("SET LOCAL lock_timeout = '4s'"), second.query("SET LOCAL lock_timeout = '4s'")]);
  const wait = await waitForBlock(observer, second);
  await first.query(`SELECT id FROM "${schema}".source WHERE id = 'entry' FOR UPDATE`);
  await first.query(`INSERT INTO "${schema}".audit VALUES ('attempt-first')`);
  await second.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await second.query(`INSERT INTO "${schema}".audit VALUES ('attempt-second')`);
  const waitingRow = second.query(`UPDATE "${schema}".source SET owner = 'second' WHERE id = 'entry'`);
  await wait();
  const waitingGate = first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  const outcomes = await Promise.allSettled([waitingRow, waitingGate]);
  const errors = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason.code, '40P01');
  await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
  await first.query('BEGIN');
  await first.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [gate]);
  await first.query(`UPDATE "${schema}".source SET owner = 'retried' WHERE id = 'entry'`);
  await first.query(`UPDATE "${schema}".projection SET owner = 'retried' WHERE vehicle = 'v1'`);
  await first.query(`INSERT INTO "${schema}".audit VALUES ('completed')`);
  await first.query('COMMIT');
  assert.deepEqual((await observer.query(`SELECT id FROM "${schema}".audit`)).rows, [{ id: 'completed' }]);
  const source = (await observer.query(`SELECT vehicle, owner FROM "${schema}".source`)).rows;
  const projection = (await observer.query(`SELECT vehicle, owner FROM "${schema}".projection`)).rows;
  assert.deepEqual(projection, source);
}));
