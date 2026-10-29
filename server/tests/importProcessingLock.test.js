import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acquireImportProcessingLock } from '../src/utils/importProcessingLock.js';

test('import lock client closes when acquisition fails and rollback cleanup also fails', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConsoleError = console.error;
  const queryFailure = new Error('advisory lock query failed');
  let closed = false;
  const client = {
    connect: async () => {},
    query: async (sql) => {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock')) throw queryFailure;
      if (sql === 'ROLLBACK') throw new Error('rollback cleanup failed');
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    end: async () => { closed = true; },
  };
  process.env.DATABASE_URL = 'postgresql://test-only.invalid/test';
  console.error = () => {};
  try {
    await assert.rejects(
      acquireImportProcessingLock('batch-1', () => client),
      (error) => error === queryFailure,
    );
    assert.equal(closed, true);
  } finally {
    console.error = originalConsoleError;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test('import lock release preserves a connection-loss error without querying a disconnected client', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConsoleError = console.error;
  const connectionError = Object.assign(new Error('PostgreSQL terminated the lock connection'), {
    code: '57P01',
  });
  const client = new EventEmitter();
  client._queryable = true;
  const queries = [];
  let closed = false;
  client.connect = async () => {};
  client.query = async (sql) => {
    queries.push(sql);
    if (sql === 'BEGIN') return { rows: [] };
    if (sql.startsWith('SELECT pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
    throw new Error(`Unexpected SQL after connection loss: ${sql}`);
  };
  client.end = async () => { closed = true; };
  process.env.DATABASE_URL = 'postgresql://test-only.invalid/test';
  console.error = () => {};
  try {
    const release = await acquireImportProcessingLock('batch-1', () => client);
    client._queryable = false;
    client.emit('error', connectionError);

    await assert.rejects(release(), (error) => error === connectionError);
    assert.deepEqual(queries, [
      'BEGIN',
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
    ]);
    assert.equal(closed, true);
  } finally {
    console.error = originalConsoleError;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
