import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.STATUS_INTEGRATION_DATABASE_URL;

test('service contact migration preserves existing rows and enforces the request key', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/status_test_/);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE vehicles (id text PRIMARY KEY)');
    await client.query('CREATE TEMP TABLE appointments (id text PRIMARY KEY)');
    await client.query("INSERT INTO vehicles (id) VALUES ('old-vehicle')");
    await client.query("INSERT INTO appointments (id) VALUES ('old-appointment')");
    const migration = await readFile(new URL('../prisma/migrations/20261114000000_service_contact_status/migration.sql', import.meta.url), 'utf8');
    await client.query(migration);
    const vehicle = await client.query('SELECT * FROM vehicles WHERE id = $1', ['old-vehicle']);
    assert.deepEqual(vehicle.rows[0], { id: 'old-vehicle', serviceContactStatus: null, serviceStatusCohort: null });
    const appointment = await client.query('SELECT * FROM appointments WHERE id = $1', ['old-appointment']);
    assert.deepEqual(appointment.rows[0], { id: 'old-appointment', serviceRequestId: null });
    await client.query("INSERT INTO vehicles (id) VALUES ('legacy-vehicle')");
    await client.query("INSERT INTO appointments (id) VALUES ('legacy-appointment')");
    await client.query('INSERT INTO appointments (id, "serviceRequestId") VALUES ($1, $2)', ['new-appointment', 'call-id']);
    await assert.rejects(
      client.query('INSERT INTO appointments (id, "serviceRequestId") VALUES ($1, $2)', ['duplicate-appointment', 'call-id']),
      (error) => error.code === '23505',
    );
  } finally {
    await client.end();
  }
});
