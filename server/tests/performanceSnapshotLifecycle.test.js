import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import {
  flushCreCallAggregates,
  noteCreAccountChangeIfAffected,
  noteCreDeleted,
  noteCreOwnershipChange,
} from '../src/utils/creCallAggregates.js';
import { beginSnapshotInvalidation, flushSnapshotInvalidation, invalidateSnapshotSourceWrite, markCreSnapshotsDirty } from '../src/utils/performanceSnapshotState.js';
import {
  findSnapshotsDueForRefresh,
  refreshDueSnapshots,
  refreshSnapshot,
  requestSnapshotRefresh,
  tick,
} from '../src/services/performanceSnapshotService.js';

after(async () => {
  await prisma.$disconnect();
});

function withMaintenance(t, value = 'true') {
  const previous = process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = value;
  t.after(() => {
    if (previous === undefined) delete process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
    else process.env.PERFORMANCE_AGGREGATES_MAINTAIN = previous;
  });
}

function matches(row, where) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((entry) => matches(row, entry));
    if (key === 'AND') return condition.every((entry) => matches(row, entry));
    if (key === 'NOT') return !matches(row, condition);
    const value = row[key];
    if (condition === null) return value == null;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition !== 'object') return value === condition;
    if ('in' in condition) return condition.in.includes(value);
    if ('not' in condition) return value !== condition.not;
    if ('lt' in condition) return value != null && value < condition.lt;
    if ('lte' in condition) return value != null && value <= condition.lte;
    if ('gte' in condition) return value != null && value >= condition.gte;
    throw new Error(`unsupported condition ${JSON.stringify(condition)}`);
  });
}

// Minimal in-memory stand-in for the snapshot table and the user lookup used by the refresh service.
function fakeDb({ users = [], rows = [] } = {}) {
  const table = rows.map((row) => ({
    status: 'pending', failureCount: 0, dirtySince: null, dirtyVersion: 0n, claimToken: null, computedAt: null, refreshStartedAt: null, lastAttemptAt: null, lastError: null, ...row,
  }));
  const calls = [];
  const snapshots = {
    createMany: async ({ data }) => {
      let count = 0;
      for (const entry of data) {
        const exists = table.some((row) => ['creId', 'ccmId', 'year', 'month', 'viewer'].every((field) => row[field] === entry[field]));
        if (!exists) {
          table.push({ status: 'pending', failureCount: 0, dirtySince: null, dirtyVersion: 0n, claimToken: null, computedAt: null, refreshStartedAt: null, lastAttemptAt: null, lastError: null, ...entry });
          count += 1;
        }
      }
      return { count };
    },
    updateMany: async ({ where, data }) => {
      calls.push({ op: 'updateMany', where, data });
      const hit = table.filter((row) => matches(row, where));
      hit.forEach((row) => {
        for (const [field, value] of Object.entries(data)) {
          row[field] = value && typeof value === 'object' && 'increment' in value
            ? row[field] + (typeof row[field] === 'bigint' ? BigInt(value.increment) : value.increment)
            : value;
        }
      });
      return { count: hit.length };
    },
    deleteMany: async ({ where }) => {
      calls.push({ op: 'deleteMany', where });
      const keep = table.filter((row) => !matches(row, where));
      const count = table.length - keep.length;
      table.splice(0, table.length, ...keep);
      return { count };
    },
    findUnique: async ({ where }) => {
      const key = where.creId_ccmId_year_month_viewer;
      return table.find((row) => ['creId', 'ccmId', 'year', 'month', 'viewer'].every((field) => row[field] === key[field])) ?? null;
    },
    findMany: async ({ where, take }) => table.filter((row) => matches(row, where)).slice(0, take),
  };
  const revisions = new Map([['global', 0n]]);
  const db = {
    table,
    calls,
    crePerformanceSnapshot: snapshots,
    performanceSnapshotRevision: {
      createMany: async ({ data }) => { for (const entry of data) if (!revisions.has(entry.scope)) revisions.set(entry.scope, 0n); },
      findMany: async ({ where }) => where.scope.in.filter((scope) => revisions.has(scope)).map((scope) => ({ scope, revision: revisions.get(scope) })),
    },
    $queryRaw: async (_query, scope) => ['global', scope].filter((key) => revisions.has(key)).map((key) => ({ scope: key, revision: revisions.get(key) })),
    user: {
      findFirst: async ({ where }) => users.find((user) => user.id === where.id) ?? null,
      findMany: async () => [],
    },
    revisions,
    $executeRaw: async () => 0,
  };
  db.$transaction = async (work) => work(db);
  return db;
}

const KEY = { creId: 'cre-1', ccmId: 'ccm-a', year: 2026, month: 11, viewer: 'CRE' };
const USER = { id: 'cre-1', name: 'Asha', ccmId: 'ccm-a', freeServiceEnabled: false, warrantyEnabled: false };
const METRICS = {
  callsThisMonth: 12, assignedCustomerCount: 30, pendingFollowUps: 4, dueServicesCount: 7, missedWarrantyCount: null,
  details: { lifetimeCalls: 100 }, cycleStartedAt: new Date('2026-11-01T00:00:00Z'), asOf: new Date('2026-11-06T06:00:00Z'),
};
const NOW = new Date('2026-11-06T06:00:00Z');

test('requested snapshots are durable and share the scheduler concurrency limit', async () => {
  const db = fakeDb();
  let signals = 0;
  const signal = () => { signals += 1; };
  const keys = Array.from({ length: 5 }, (_, i) => ({ ...KEY, creId: `request-${i}` }));
  await Promise.all([...keys, keys[0]].map((key) => requestSnapshotRefresh(key, { db, signal })));
  assert.equal(db.table.length, 5);
  assert.equal(signals, 5);

  let active = 0;
  let maximum = 0;
  const started = [];
  const releases = [];
  const refresh = async (row) => {
    active += 1;
    maximum = Math.max(maximum, active);
    started.push(row.creId);
    row.status = 'refreshing';
    await new Promise((resolve) => releases.push(resolve));
    row.status = 'ok';
    active -= 1;
    return { refreshed: true };
  };
  const batch = tick({ refresh: () => refreshDueSnapshots({ now: NOW, db, refresh }) });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(active, 2);
  const later = { ...KEY, creId: 'later-request' };
  await requestSnapshotRefresh(later, { db, signal });
  await tick({ refresh: () => refreshDueSnapshots({ now: NOW, db, refresh }) });
  assert.equal(active, 2);
  for (let i = 0; i < keys.length; i += 1) {
    releases.shift()();
    await flush();
  }
  await batch;
  assert.equal(maximum, 2);
  assert.equal(new Set(started).size, 5);
  assert.equal(db.table.find((row) => row.creId === later.creId).status, 'pending');

  const next = tick({ refresh: () => refreshDueSnapshots({ now: NOW, db, refresh }) });
  await flush();
  assert.equal(started.at(-1), later.creId);
  releases.shift()();
  await next;
});

test('snapshot request logs persistence failures and does not signal success', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  let signalled = false;
  const result = await requestSnapshotRefresh(KEY, {
    db: { crePerformanceSnapshot: { createMany: async () => { throw new Error('database unavailable'); } } },
    signal: () => { signalled = true; },
  });
  assert.equal(result, false);
  assert.equal(signalled, false);
  assert.match(log.mock.calls[0].arguments[1].message, /database unavailable/);
});

test('dirty marking survives a refresh finishing between its updates', async () => {
  const db = fakeDb({ rows: [{ ...KEY, status: 'refreshing', callsThisMonth: 7 }] });
  const update = db.crePerformanceSnapshot.updateMany;
  let first = true;
  db.crePerformanceSnapshot.updateMany = async (args) => {
    const result = await update(args);
    if (first) {
      first = false;
      db.table[0].status = 'ok';
    }
    return result;
  };
  await markCreSnapshotsDirty(db, { creIds: [KEY.creId], now: NOW });
  assert.equal(db.table[0].status, 'dirty');
  assert.equal(db.table[0].dirtyVersion, 1n);
});

test('a replaced worker cannot delete a snapshot after a missing-user lookup', async () => {
  const db = fakeDb({ users: [USER] });
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  db.user.findFirst = async () => {
    if (++calls === 1) {
      entered();
      await blocked;
      return null;
    }
    return USER;
  };
  const older = refreshSnapshot(KEY, { db, now: NOW, compute: async () => METRICS });
  await started;
  const newer = await refreshSnapshot(KEY, { db, now: new Date(NOW.getTime() + 11 * 60000), compute: async () => METRICS });
  release();
  assert.equal(newer.refreshed, true);
  assert.deepEqual(await older, { refreshed: false, reason: 'superseded' });
  assert.equal(db.table.length, 1);
  assert.equal(db.table[0].callsThisMonth, 12);
  assert.equal(db.table[0].status, 'ok');
});

// A transaction stand-in that records every statement, so tests can prove where the work was done.
function fakeTransaction() {
  const log = [];
  const snapshotCalls = [];
  const transaction = {
    log,
    snapshotCalls,
    $executeRaw: async () => { log.push('lock'); return 1; },
    performanceSnapshotRevision: {
      update: async () => { log.push('revision:global'); },
      upsert: async ({ where }) => { log.push(`revision:${where.scope}`); },
    },
    creCallDaily: {
      deleteMany: async ({ where }) => { log.push(`daily.deleteMany:${where.userId}`); return { count: 0 }; },
      createMany: async () => ({ count: 0 }),
    },
    callLog: { groupBy: async () => [], findMany: async () => [] },
    crePerformanceSnapshot: {
      updateMany: async (args) => { snapshotCalls.push({ op: 'updateMany', ...args }); return { count: 1 }; },
      deleteMany: async (args) => { snapshotCalls.push({ op: 'deleteMany', ...args }); return { count: 1 }; },
    },
  };
  return transaction;
}

function dirtyMarks(transaction) {
  return transaction.snapshotCalls.filter((call) => call.op === 'updateMany' && call.data.status === 'dirty');
}

test('enabling Free Service for a CRE flags every month of that CRE inside the same transaction', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  noteCreAccountChangeIfAffected(
    transaction,
    { id: 'cre-1', role: 'CRE', ccmId: 'ccm-a', status: 'active', freeServiceEnabled: false, warrantyEnabled: false },
    { id: 'cre-1', role: 'CRE', ccmId: 'ccm-a', status: 'active', freeServiceEnabled: true, warrantyEnabled: false },
  );
  const result = await flushCreCallAggregates(transaction);
  assert.deepEqual(result.creIds, ['cre-1']);
  assert.equal(result.changed, true);
  const [mark] = dirtyMarks(transaction);
  assert.deepEqual(mark.where.ccmId, { in: ['ccm-a'] });
  assert.ok(transaction.log.includes('revision:ccm:ccm-a'));
  assert.equal('year' in mark.where, false, 'permission changes must flag historical months as well');
});

test('disabling Warranty or Free Service access is flagged the same way', async (t) => {
  withMaintenance(t);
  for (const field of ['freeServiceEnabled', 'warrantyEnabled']) {
    const transaction = fakeTransaction();
    noteCreAccountChangeIfAffected(
      transaction,
      { id: 'cre-2', role: 'CRE', ccmId: 'ccm-a', status: 'active', freeServiceEnabled: true, warrantyEnabled: true },
      { id: 'cre-2', role: 'CRE', ccmId: 'ccm-a', status: 'active', freeServiceEnabled: true, warrantyEnabled: true, [field]: false },
    );
    await flushCreCallAggregates(transaction);
    assert.equal(dirtyMarks(transaction).length, 1, `${field} change should flag snapshots`);
  }
});

test('role changes to or from Free-Service CRE, CCM transfers and status changes are flagged', async (t) => {
  withMaintenance(t);
  const base = { id: 'cre-3', role: 'CRE', ccmId: 'ccm-a', status: 'active', freeServiceEnabled: false, warrantyEnabled: false };
  const cases = [
    { ...base, role: 'FREE_SERVICE_CRE' },
    { ...base, status: 'inactive' },
    { ...base, ccmId: 'ccm-b' },
  ];
  for (const after of cases) {
    const transaction = fakeTransaction();
    noteCreAccountChangeIfAffected(transaction, base, after);
    await flushCreCallAggregates(transaction);
    assert.equal(dirtyMarks(transaction).length, 1);
  }
});

test('a CCM transfer removes the old CCM snapshots and keeps the new ones for the scheduler to seed', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  noteCreAccountChangeIfAffected(
    transaction,
    { id: 'cre-4', role: 'CRE', ccmId: 'ccm-a', status: 'active' },
    { id: 'cre-4', role: 'CRE', ccmId: 'ccm-b', status: 'active' },
  );
  await flushCreCallAggregates(transaction);
  const removal = transaction.snapshotCalls.find((call) => call.op === 'deleteMany');
  assert.deepEqual(removal.where, { creId: 'cre-4', ccmId: { in: ['ccm-a'] } });
  assert.deepEqual(transaction.log.filter((entry) => entry.startsWith('revision:')), ['revision:ccm:ccm-a', 'revision:ccm:ccm-b']);
  assert.deepEqual(dirtyMarks(transaction)[0].where.ccmId, { in: ['ccm-a', 'ccm-b'] });
});

test('a transaction does not reacquire a previously invalidated CCM during assignment flush', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  await invalidateSnapshotSourceWrite(transaction, { ccmIds: ['ccm-a'] });
  noteCreOwnershipChange(transaction, { ccmId: 'ccm-a', creIds: ['cre-1'] });
  await flushCreCallAggregates(transaction);
  assert.deepEqual(transaction.log.filter((entry) => entry.startsWith('revision:')), ['revision:ccm:ccm-a']);
  assert.equal(dirtyMarks(transaction).length, 1);
});

test('deferred invalidation coalesces scopes after aggregate work in deterministic order', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  beginSnapshotInvalidation(transaction);
  await invalidateSnapshotSourceWrite(transaction, { ccmIds: ['ccm-b'] });
  await invalidateSnapshotSourceWrite(transaction, { ccmIds: ['ccm-a'] });
  noteCreOwnershipChange(transaction, { ccmId: 'ccm-b', creIds: ['cre-1'] });
  assert.equal(transaction.log.length, 0);
  await flushCreCallAggregates(transaction);
  assert.deepEqual(transaction.log.filter((entry) => entry.startsWith('revision:')), ['revision:ccm:ccm-a', 'revision:ccm:ccm-b']);
  assert.ok(transaction.log.indexOf('daily.deleteMany:cre-1') < transaction.log.indexOf('revision:ccm:ccm-a'));
  assert.equal(dirtyMarks(transaction).length, 1);
  assert.equal(await flushSnapshotInvalidation(transaction), false);
});

test('unknown deferred scope supersedes scoped revisions with global invalidation', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  beginSnapshotInvalidation(transaction);
  await invalidateSnapshotSourceWrite(transaction, { ccmIds: ['ccm-b'] });
  await invalidateSnapshotSourceWrite(transaction);
  await invalidateSnapshotSourceWrite(transaction, { ccmIds: ['ccm-a'] });
  await flushSnapshotInvalidation(transaction);
  assert.deepEqual(transaction.log, ['revision:global']);
  assert.equal('ccmId' in dirtyMarks(transaction)[0].where, false);
});

test('unrelated user edits and non-CRE accounts never touch snapshots', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  const before = { id: 'cre-5', role: 'CRE', ccmId: 'ccm-a', status: 'active', freeServiceEnabled: false, warrantyEnabled: false, name: 'Old' };
  noteCreAccountChangeIfAffected(transaction, before, { ...before, name: 'New' });
  noteCreAccountChangeIfAffected(transaction, { id: 'gm', role: 'GM' }, { id: 'gm', role: 'GM', status: 'inactive' });
  const result = await flushCreCallAggregates(transaction);
  assert.equal(result.changed, false);
  assert.equal(transaction.snapshotCalls.length, 0);
});

test('maintenance off: notes and flushes are no-ops that never query', async (t) => {
  withMaintenance(t, 'false');
  const transaction = fakeTransaction();
  noteCreOwnershipChange(transaction, { creIds: ['cre-1'] });
  noteCreDeleted(transaction, { creId: 'cre-1' });
  const result = await flushCreCallAggregates(transaction);
  assert.deepEqual(result, { creIds: [], changed: false });
  assert.equal(transaction.log.length + transaction.snapshotCalls.length, 0);
});

test('ownership changes rebuild counters and flag snapshots on the same transaction object', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  noteCreOwnershipChange(transaction, { creIds: ['cre-b', 'cre-a'] });
  const result = await flushCreCallAggregates(transaction);
  assert.deepEqual(result.creIds.sort(), ['cre-a', 'cre-b']);
  assert.deepEqual(transaction.log.filter((entry) => entry.startsWith('daily.deleteMany')), ['daily.deleteMany:cre-a', 'daily.deleteMany:cre-b']);
  assert.equal(dirtyMarks(transaction).length, 1);
  // A second flush has nothing pending: the registry entry is consumed.
  assert.equal((await flushCreCallAggregates(transaction)).changed, false);
});

test('a deleted CRE has its counters cleared and its snapshots removed after invalidation', async (t) => {
  withMaintenance(t);
  const transaction = fakeTransaction();
  noteCreDeleted(transaction, { creId: 'cre-gone' });
  await flushCreCallAggregates(transaction);
  assert.equal(dirtyMarks(transaction).length, 1);
  assert.ok(transaction.log.includes('revision:global'));
  assert.deepEqual(transaction.snapshotCalls.find((call) => call.op === 'deleteMany').where, { creId: { in: ['cre-gone'] } });
  assert.ok(transaction.log.includes('daily.deleteMany:cre-gone'));
});

test('a change committed while a refresh is calculating keeps the snapshot dirty', async () => {
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'ok', computedAt: new Date('2026-11-06T05:00:00Z') }] });
  const compute = async () => {
    await markCreSnapshotsDirty(db, { creIds: ['cre-1'], now: new Date(NOW.getTime() + 1000) });
    return METRICS;
  };
  const result = await refreshSnapshot(KEY, { now: NOW, db, compute });
  assert.deepEqual(result, { refreshed: false, reason: 'dirty' });
  const [row] = db.table;
  assert.equal(row.status, 'dirty');
  assert.ok(row.dirtySince, 'dirtySince must survive the refresh');
  assert.equal(row.callsThisMonth, undefined, 'last good values must not be replaced');
});

test('a consistent-read transaction failure preserves last-good metrics', async (t) => {
  const previous = process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED;
  process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED;
    else process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED = previous;
  });
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'ok', callsThisMonth: 7, computedAt: NOW }] });
  db.$transaction = async (work, options) => {
    if (options) {
      assert.equal(options.isolationLevel, 'RepeatableRead');
      assert.equal(options.timeout, 60000);
      assert.equal(options.maxWait, 2000);
      throw new Error('transaction timed out');
    }
    return work(db);
  };
  const log = t.mock.method(console, 'error', () => {});
  const result = await refreshSnapshot(KEY, { now: NOW, db, compute: async () => METRICS });
  assert.equal(result.reason, 'failed');
  assert.equal(db.table[0].status, 'failed');
  assert.equal(db.table[0].callsThisMonth, 7);
  assert.match(db.table[0].lastError, /timed out/);
  assert.equal(log.mock.callCount(), 1);
});

test('a change made before the refresh started is cleared by it', async () => {
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'dirty', dirtySince: new Date(NOW.getTime() - 5000), computedAt: new Date('2026-11-06T05:00:00Z') }] });
  await refreshSnapshot(KEY, { now: NOW, db, compute: async () => METRICS });
  const [row] = db.table;
  assert.equal(row.status, 'ok');
  assert.equal(row.dirtySince, null);
  assert.equal(row.failureCount, 0);
  assert.equal(row.lastError, null);
});

test('a failed refresh keeps the last good values and never clears the dirty flag', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dirtySince = new Date(NOW.getTime() - 5000);
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'dirty', dirtySince, computedAt: new Date('2026-11-06T05:00:00Z'), callsThisMonth: 9 }] });
  const result = await refreshSnapshot(KEY, { now: NOW, db, compute: async () => { throw new Error('boom'); } });
  assert.equal(result.refreshed, false);
  const [row] = db.table;
  assert.equal(row.status, 'failed');
  assert.equal(row.lastError, 'boom');
  assert.equal(row.failureCount, 1);
  assert.equal(row.callsThisMonth, 9, 'last good values are retained');
  assert.equal(row.dirtySince.getTime(), dirtySince.getTime());
});

test('repeated failures increase the failure count and respect the backoff before the next attempt', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'ok', computedAt: new Date('2026-11-06T05:00:00Z') }] });
  await refreshSnapshot(KEY, { now: NOW, db, compute: async () => { throw new Error('one'); } });
  await refreshSnapshot(KEY, { now: new Date(NOW.getTime() + 1000), db, compute: async () => { throw new Error('two'); } });
  assert.equal(db.table[0].failureCount, 2);
  const tooSoon = await findSnapshotsDueForRefresh({ now: new Date(NOW.getTime() + 30 * 1000), db });
  assert.equal(tooSoon.length, 0, 'inside the backoff window the failed row is not retried');
  const later = await findSnapshotsDueForRefresh({ now: new Date(NOW.getTime() + 10 * 60 * 1000), db });
  assert.equal(later.length, 1);
});

test('scheduler selects pending work despite a large failed backlog and honors exact retry boundaries', async () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({
    ...KEY, creId: `failed-${i}`, status: 'failed', failureCount: 1, lastAttemptAt: NOW,
  }));
  rows.push({ ...KEY, creId: 'pending', status: 'pending' });
  const db = fakeDb({ rows });
  assert.deepEqual((await findSnapshotsDueForRefresh({ now: NOW, limit: 1, db })).map((row) => row.creId), ['pending']);

  for (const [failures, delay] of [[0, 60], [1, 60], [2, 120], [3, 240], [4, 480], [5, 900], [30, 900]]) {
    const retry = fakeDb({ rows: [{
      ...KEY, status: 'failed', failureCount: failures, lastAttemptAt: new Date(NOW.getTime() - delay * 1000),
    }] });
    assert.equal((await findSnapshotsDueForRefresh({ now: new Date(NOW.getTime() - 1), db: retry })).length, 0);
    assert.equal((await findSnapshotsDueForRefresh({ now: NOW, db: retry })).length, 1);
  }
  const noAttempt = fakeDb({ rows: [{ ...KEY, status: 'failed', failureCount: 100, lastAttemptAt: null }] });
  assert.equal((await findSnapshotsDueForRefresh({ now: NOW, db: noAttempt })).length, 1);
});

test('only one refresh can claim a snapshot at a time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'ok', computedAt: new Date('2026-11-06T05:00:00Z') }] });
  const first = refreshSnapshot(KEY, { now: NOW, db, compute: async () => { await gate; return METRICS; } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await refreshSnapshot(KEY, { now: new Date(NOW.getTime() + 1000), db, compute: async () => METRICS });
  assert.deepEqual(second, { refreshed: false, reason: 'already-refreshing' });
  release();
  assert.equal((await first).refreshed, true);
});

test('snapshot timing identifies a pending computation and subsequent persistence without logging metric values', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'pending' }] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = refreshSnapshot(KEY, { now: NOW, db, compute: async () => { await gate; return METRICS; } });
  await new Promise((resolve) => setImmediate(resolve));
  const events = () => log.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  const before = events();
  assert.ok(before.some((event) => event.event === 'phase_start' && event.phase === 'compute'));
  assert.ok(!before.some((event) => event.event === 'phase_end' && event.phase === 'compute'));
  release();
  assert.equal((await pending).refreshed, true);
  const after = events();
  assert.equal(new Set(after.map((event) => event.attemptId)).size, 1);
  assert.ok(after.some((event) => event.event === 'phase_end' && event.phase === 'compute' && event.outcome === 'ok'));
  assert.ok(after.some((event) => event.event === 'phase_end' && event.phase === 'persist_clean'));
  assert.ok(after.some((event) => event.event === 'attempt_result' && event.outcome === 'ok'));
  assert.ok(after.every((event) => Number.isFinite(event.elapsedMs)));
  assert.ok(!JSON.stringify(after).includes('lifetimeCalls'));
});

test('snapshot timing records failures without logging the error message', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'pending' }] });
  const result = await refreshSnapshot(KEY, {
    now: NOW, db, compute: async () => { throw new Error('sensitive-error-detail'); },
  });
  assert.equal(result.refreshed, false);
  const events = log.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  assert.ok(events.some((event) => event.phase === 'compute' && event.outcome === 'error'));
  assert.ok(events.some((event) => event.phase === 'persist_failure' && event.outcome === 'ok'));
  assert.ok(!JSON.stringify(events).includes('sensitive-error-detail'));
});

test('snapshot timing reports a failure-handler rejection without hiding it', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const db = fakeDb({ users: [USER], rows: [{ ...KEY, status: 'pending' }] });
  const update = db.crePerformanceSnapshot.updateMany;
  db.crePerformanceSnapshot.updateMany = async (args) => {
    if (args.data.status === 'failed') throw new Error('failure-storage-unavailable');
    return update(args);
  };
  await assert.rejects(refreshSnapshot(KEY, {
    now: NOW, db, compute: async () => { throw new Error('computation-failed'); },
  }), /failure-storage-unavailable/);
  const events = log.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  assert.ok(events.some((event) => event.phase === 'persist_failure' && event.outcome === 'error'));
  assert.ok(events.some((event) => event.phase === 'attempt' && event.outcome === 'error'));
  assert.ok(!JSON.stringify(events).includes('failure-storage-unavailable'));
  assert.equal(db.table[0].status, 'refreshing');
});

test('batch refresh runs at most two workers and continues after an unexpected rejection', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...KEY, creId: `cre-${i}`, status: 'pending' }));
  const db = fakeDb({ rows });
  const started = [];
  const releases = new Map();
  let active = 0;
  let maxActive = 0;
  const refresh = async (row) => {
    started.push(row.creId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await new Promise((resolve, reject) => releases.set(row.creId, { resolve, reject }));
    } finally {
      active -= 1;
    }
  };
  const batch = refreshDueSnapshots({ now: NOW, db, refresh });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.deepEqual(started, ['cre-0', 'cre-1']);
  releases.get('cre-0').reject(new Error('claim failed'));
  await flush();
  assert.deepEqual(started, ['cre-0', 'cre-1', 'cre-2']);
  releases.get('cre-1').resolve({ refreshed: false });
  await flush();
  assert.deepEqual(started, ['cre-0', 'cre-1', 'cre-2', 'cre-3']);
  releases.get('cre-2').resolve({ refreshed: true });
  await flush();
  assert.deepEqual(started, ['cre-0', 'cre-1', 'cre-2', 'cre-3', 'cre-4']);
  releases.get('cre-3').resolve({ refreshed: true });
  releases.get('cre-4').resolve({ refreshed: true });
  assert.deepEqual(await batch, { due: 5, refreshed: 3 });
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /cre-0/);
  assert.match(log.mock.calls[0].arguments[1].message, /claim failed/);
});

test('an empty batch has no refreshes', async () => {
  const db = fakeDb();
  const result = await refreshDueSnapshots({
    now: NOW,
    db,
    refresh: () => { throw new Error('unexpected refresh'); },
  });
  assert.deepEqual(result, { due: 0, refreshed: 0 });
});

test('scheduler ticks do not overlap while a previous tick is running', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    await gate;
  };
  const first = tick({ refresh });
  await tick({ refresh });
  assert.equal(calls, 1);
  release();
  await first;
  await tick({ refresh });
  assert.equal(calls, 2);
});

test('the scheduler query picks up dirty, pending, aged and stuck rows but not fresh ones', async () => {
  const fresh = new Date(NOW.getTime() - 60 * 1000);
  const db = fakeDb({
    rows: [
      { ...KEY, creId: 'fresh', status: 'ok', computedAt: fresh },
      { ...KEY, creId: 'dirty', status: 'dirty', computedAt: fresh },
      { ...KEY, creId: 'pending', status: 'pending' },
      { ...KEY, creId: 'aged', status: 'ok', computedAt: new Date(NOW.getTime() - 11 * 60 * 1000) },
      {
        ...KEY,
        creId: 'historical-free-service',
        viewer: 'FREE_SERVICE_CRE',
        year: 2025,
        month: 10,
        status: 'ok',
        computedAt: new Date(NOW.getTime() - 11 * 60 * 1000),
      },
      { ...KEY, creId: 'stuck', status: 'refreshing', refreshStartedAt: new Date(NOW.getTime() - 11 * 60 * 1000) },
      { ...KEY, creId: 'busy', status: 'refreshing', refreshStartedAt: fresh },
    ],
  });
  const due = (await findSnapshotsDueForRefresh({ now: NOW, db })).map((row) => row.creId).sort();
  assert.deepEqual(due, ['aged', 'dirty', 'historical-free-service', 'pending', 'stuck']);
});

test('a CRE moved to another CCM has its stale snapshot removed instead of refreshed', async () => {
  const db = fakeDb({ users: [{ ...USER, ccmId: 'ccm-b' }], rows: [{ ...KEY, status: 'dirty', computedAt: NOW }] });
  const result = await refreshSnapshot(KEY, { now: NOW, db, compute: async () => METRICS });
  assert.equal(result.reason, 'cre-not-in-ccm');
  assert.equal(db.table.length, 0);
});
