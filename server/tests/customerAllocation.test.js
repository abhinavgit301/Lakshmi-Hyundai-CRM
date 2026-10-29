import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateUnassignedMasterCallListEntries,
  selectLeastLoadedCre,
  selectNextCre,
} from '../src/utils/customerAllocation.js';

function distribute(creIds, workloads, customerCount) {
  const assignments = [];
  for (let index = 0; index < customerCount; index += 1) {
    const creId = selectLeastLoadedCre(creIds, workloads);
    assignments.push(creId);
    workloads.set(creId, (workloads.get(creId) || 0) + 1);
  }
  return assignments;
}

test('workload-aware allocation round-robins seven equal-load customers across three CREs', () => {
  const workloads = new Map([['cre-a', 0], ['cre-b', 0], ['cre-c', 0]]);
  const assignments = distribute(['cre-a', 'cre-b', 'cre-c'], workloads, 7);

  assert.deepEqual(assignments, ['cre-a', 'cre-b', 'cre-c', 'cre-a', 'cre-b', 'cre-c', 'cre-a']);
  assert.deepEqual([...workloads.values()].sort(), [2, 2, 3]);
});

test('workload-aware allocation favors the least-loaded CRE without moving existing assignments', () => {
  const workloads = new Map([['cre-a', 100], ['cre-b', 100], ['cre-c', 0]]);
  const assignments = distribute(['cre-a', 'cre-b', 'cre-c'], workloads, 3);

  assert.deepEqual(assignments, ['cre-c', 'cre-c', 'cre-c']);
  assert.deepEqual([...workloads.values()], [100, 100, 3]);
});

test('workload-aware allocation uses a stable tie break and alternates as workloads equalize', () => {
  const workloads = new Map([['cre-b', 5], ['cre-a', 5], ['cre-c', 7]]);
  const assignments = distribute(['cre-b', 'cre-a', 'cre-c'], workloads, 4);

  assert.deepEqual(assignments, ['cre-b', 'cre-a', 'cre-b', 'cre-a']);
});

test('import batches cap one CRE at half the new customers so teammates are not left idle', () => {
  const creIds = ['cre-a', 'cre-b', 'cre-c'];
  const workloads = new Map([['cre-a', 100], ['cre-b', 100], ['cre-c', 0]]);
  const batchCounts = new Map(creIds.map((id) => [id, 0]));
  const limit = Math.ceil(7 / 2);
  const assignments = [];

  for (let index = 0; index < 7; index += 1) {
    const creId = selectNextCre(creIds, workloads, batchCounts, limit);
    assignments.push(creId);
    batchCounts.set(creId, batchCounts.get(creId) + 1);
    workloads.set(creId, workloads.get(creId) + 1);
  }

  assert.deepEqual(assignments, ['cre-c', 'cre-c', 'cre-c', 'cre-c', 'cre-a', 'cre-b', 'cre-a']);
  assert.deepEqual([...batchCounts.values()].sort(), [1, 2, 4]);
});

test('shared allocation continues to assign call-list entries without import-only mutation hooks', async () => {
  const entry = { id: 'call-1', vin: 'VIN-1' };
  let assignedOwner = null;
  const transaction = {
    $queryRaw: async () => [],
    user: {
      findMany: async () => [{ id: 'cre-1' }],
    },
    masterCallList: {
      findMany: async ({ where }) => (where.ownerUserId === null ? [entry] : []),
      update: async ({ data }) => {
        assignedOwner = data.ownerUserId;
        return { ...entry, ...data };
      },
    },
    allocation: {
      findMany: async () => [],
    },
    auditLog: {
      create: async () => ({}),
    },
  };

  const count = await allocateUnassignedMasterCallListEntries(transaction, 'ccm-1', 'admin-1');

  assert.equal(count, 1);
  assert.equal(assignedOwner, 'cre-1');
});

test('import mutation hook receives exact before and persisted after assignment snapshots', async () => {
  const entry = {
    id: 'call-tracked',
    vin: 'VIN-TRACKED',
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  };
  const afterTimestamp = new Date('2025-01-02T00:00:00.000Z');
  let assignedOwner = null;
  const recordedChanges = [];
  const transaction = {
    $queryRaw: async () => [],
    user: {
      findMany: async () => [{ id: 'cre-1' }],
    },
    masterCallList: {
      findMany: async ({ where }) => (where.ownerUserId === null ? [entry] : []),
      update: async ({ data }) => {
        assignedOwner = data.ownerUserId;
        return { ...entry, ...data, updatedAt: afterTimestamp };
      },
    },
    allocation: {
      findMany: async () => [],
    },
    auditLog: {
      create: async () => ({}),
    },
  };

  await allocateUnassignedMasterCallListEntries(transaction, 'ccm-1', 'admin-1', {
    onMutation: async (change, update) => {
      const updated = await update();
      recordedChanges.push({
        before: change.before,
        after: { ownerUserId: updated.ownerUserId, updatedAt: updated.updatedAt },
      });
    },
  });

  assert.equal(assignedOwner, 'cre-1');
  assert.deepEqual(recordedChanges, [{
    before: { ownerUserId: null, updatedAt: entry.updatedAt },
    after: { ownerUserId: 'cre-1', updatedAt: afterTimestamp },
  }]);
});
