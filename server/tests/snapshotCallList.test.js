import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotLifecycleResolver, isSnapshotSlimCallListEnabled, loadSnapshotCallListRecords } from '../src/utils/snapshotCallList.js';
import { refreshSnapshot } from '../src/services/performanceSnapshotService.js';

test('snapshot optimization is disabled unless explicitly enabled', () => {
  for (const value of [undefined, '', 'false', 'yes']) {
    assert.equal(isSnapshotSlimCallListEnabled({ PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED: value }), false);
  }
  for (const value of ['true', '1', ' TRUE ']) {
    assert.equal(isSnapshotSlimCallListEnabled({ PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED: value }), true);
  }
});

test('lifecycle reuse is scoped to a record and identical evaluation time', () => {
  let calls = 0;
  const resolve = createSnapshotLifecycleResolver((record, time) => ({ id: record.id, time: time.getTime(), call: ++calls }));
  const first = { id: 'one' };
  const second = { id: 'two' };
  const time = new Date('2026-11-14T06:00:00Z');
  assert.equal(resolve(first, time), resolve(first, new Date(time)));
  assert.equal(calls, 1);
  resolve(second, time);
  resolve(first, new Date(time.getTime() + 1));
  assert.equal(calls, 3);
});

test('snapshot loader canonicalizes before loading scoped shared history and preserves missing vehicles', async () => {
  const date = new Date('2025-11-14T00:00:00Z');
  const vehicle = { customerId: 'customer', saleDate: null, physicalVehicleId: 'physical' };
  const rows = [
    { id: 'newer', ccmId: 'team', vin: 'vin', ownerUserId: 'cre', createdAt: new Date(2000), vehicle },
    { id: 'older-unassigned', ccmId: 'team', vin: 'vin', ownerUserId: null, createdAt: new Date(1000), vehicle },
    { id: 'unlinked', ccmId: 'team', vin: 'other', ownerUserId: null, createdAt: new Date(500), vehicle: null },
  ];
  let query;
  const db = {
    masterCallList: { findMany: async ({ take }) => { assert.equal(take, 500); return rows; } },
    workshopVisit: { findMany: async (args) => {
      query = args;
      return [{ physicalVehicleId: 'physical', visitDate: date, importedDetails: { workType: 'Paid Service' } }];
    } },
  };
  const result = await loadSnapshotCallListRecords({ ccmId: 'team' }, new Date('2026-11-14T06:00:00Z'), { role: 'CRE', id: 'cre', ccmId: 'team' }, { db });
  assert.deepEqual(result.map((record) => record.id), ['newer', 'unlinked']);
  assert.deepEqual(query.where.physicalVehicleId, { in: ['physical'] });
  assert.ok(query.where.physicalVehicle.is.vehicles.some.OR);
  assert.equal(result[1].customerId, null);
  assert.deepEqual(result[1].workshopVisits, []);
  assert.equal(result[1].dueDate, null);
});

test('snapshot loader surfaces database errors', async () => {
  const expected = new Error('test database failure');
  const db = { masterCallList: { findMany: async () => { throw expected; } } };
  await assert.rejects(loadSnapshotCallListRecords({}, new Date(), {}, { db }), (error) => error === expected);
});

test('a loader error retains the last good snapshot and a retry can succeed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const state = { status: 'ok', callsThisMonth: 7, failureCount: 0, dirtyVersion: 0n };
  const db = {
    crePerformanceSnapshot: {
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ data }) => {
        for (const [field, value] of Object.entries(data)) {
          state[field] = value && typeof value === 'object' && 'increment' in value
            ? state[field] + value.increment : value;
        }
        return { count: 1 };
      },
      findUnique: async () => state,
    },
    performanceSnapshotRevision: {
      createMany: async () => {},
      findMany: async () => [{ scope: 'global', revision: 0n }, { scope: 'ccm:team', revision: 0n }],
    },
    $queryRaw: async () => [{ scope: 'global', revision: 0n }, { scope: 'ccm:team', revision: 0n }],
    $executeRaw: async () => 0,
    user: { findFirst: async () => ({ id: 'cre', ccmId: 'team' }) },
  };
  db.$transaction = async (work) => work(db);
  const key = { creId: 'cre', ccmId: 'team', year: 2026, month: 11, viewer: 'CRE' };
  const now = new Date('2026-11-14T06:00:00Z');
  const expected = new Error('test history failure');
  const source = {
    masterCallList: { findMany: async () => [{ id: 'one', ccmId: 'team', vin: 'vin', createdAt: now,
      ownerUserId: 'cre', vehicle: { physicalVehicleId: 'physical', customerId: 'customer' } }] },
    workshopVisit: { findMany: async () => { throw expected; } },
  };
  const failed = await refreshSnapshot(key, {
    now, db, compute: async () => loadSnapshotCallListRecords({}, now, { role: 'CRE', id: 'cre', ccmId: 'team' }, { db: source }),
  });
  assert.equal(failed.reason, 'failed');
  assert.equal(failed.error, expected);
  assert.equal(state.status, 'failed');
  assert.equal(state.callsThisMonth, 7);
  assert.equal(state.failureCount, 1);
  const retried = await refreshSnapshot(key, {
    now, db, compute: async () => ({ callsThisMonth: 9, details: {}, asOf: now }),
  });
  assert.equal(retried.refreshed, true);
  assert.equal(state.status, 'ok');
  assert.equal(state.callsThisMonth, 9);
  assert.equal(state.failureCount, 0);
});
