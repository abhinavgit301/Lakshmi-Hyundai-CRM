import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('source-first cleanup and projection-first assignment can deadlock', {
  skip: !databaseUrl, timeout: 15000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');

  const clients = Array.from({ length: 3 }, () => new pg.Client({ connectionString: databaseUrl }));
  const [cleanup, assignment, observer] = clients;
  const table = `assignment_lock_${randomUUID().replaceAll('-', '')}`;
  const lockKey = `cre-assignment-projection:${randomUUID()}`;
  let created = false;
  let transactionsStarted = false;
  try {
    await Promise.all(clients.map((client) => client.connect()));
    await observer.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY, owner text NOT NULL)`);
    created = true;
    await observer.query(`INSERT INTO "${table}" VALUES (1, 'initial')`);
    await Promise.all([cleanup.query('BEGIN'), assignment.query('BEGIN')]);
    transactionsStarted = true;
    await Promise.all([
      cleanup.query("SET LOCAL lock_timeout = '5s'"),
      assignment.query("SET LOCAL lock_timeout = '5s'"),
    ]);
    await cleanup.query(`SELECT id FROM "${table}" WHERE id = 1 FOR UPDATE`);
    await assignment.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

    const assignmentPid = (await assignment.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const waitingAssignment = assignment.query(`UPDATE "${table}" SET owner = 'changed' WHERE id = 1`);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await observer.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [assignmentPid]);
      if (result.rows[0].blockers > 0) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!blocked) {
      await cleanup.query('ROLLBACK');
      await waitingAssignment;
      assert.fail('Assignment did not wait for the source-row lock.');
    }

    const waitingCleanup = cleanup.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
    const results = await Promise.allSettled([waitingAssignment, waitingCleanup]);
    const failures = results.filter((result) => result.status === 'rejected');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.code, '40P01');
    await Promise.all([cleanup.query('ROLLBACK'), assignment.query('ROLLBACK')]);
    const row = await observer.query(`SELECT owner FROM "${table}" WHERE id = 1`);
    assert.equal(row.rows[0].owner, 'initial');
  } finally {
    if (transactionsStarted) await Promise.all([cleanup.query('ROLLBACK'), assignment.query('ROLLBACK')]);
    if (created) await observer.query(`DROP TABLE "${table}"`);
    await Promise.all(clients.map((client) => client.end()));
  }
});
