import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAllocationQueueRecords,
  consolidateMasterCallListEntries,
  findCanonicalMasterCallListEntry,
  includeUnassignedAllocationQueue,
} from '../src/utils/masterCallList.js';
import { latestWorkshopVisitOrderBy } from '../src/utils/workshopVisitOrdering.js';

function createMclStore(initialEntries = []) {
  const entries = [...initialEntries];
  const tails = new Map();
  async function acquire(key) {
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(key, previous.then(() => current));
    await previous;
    return release;
  }
  async function transaction(callback) {
    const releases = [];
    const snapshot = entries.map((entry) => ({ ...entry }));
    const tx = {
      $queryRaw: async (_strings, lockName) => {
        releases.push(await acquire(lockName));
      },
      masterCallList: {
        findMany: async ({ where }) => entries.filter((entry) => (
          entry.vin === where.vin && entry.ccmId === where.ccmId
        )).sort((left, right) => (
          new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
          || String(left.id).localeCompare(String(right.id))
        )),
        create: async ({ data }) => {
          const entry = { id: `mcl-${entries.length + 1}`, createdAt: new Date(), ...data };
          entries.push(entry);
          return entry;
        },
        update: async ({ where, data }) => {
          const entry = entries.find((item) => item.id === where.id);
          Object.assign(entry, data);
          return entry;
        },
      },
    };
    try {
      return await callback(tx);
    } catch (error) {
      entries.splice(0, entries.length, ...snapshot);
      throw error;
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
  return { entries, transaction };
}

async function ensureEntry(transaction, data) {
  const existing = await findCanonicalMasterCallListEntry(transaction, data.vin, data.ccmId);
  if (existing) {
    return transaction.masterCallList.update({ where: { id: existing.id }, data });
  }
  return transaction.masterCallList.create({ data });
}

test('concurrent imports serialize by CCM and VIN so only one MCL entry is created', async () => {
  const store = createMclStore();
  await Promise.all([
    store.transaction((transaction) => ensureEntry(transaction, { vin: 'VIN-1', ccmId: 'ccm-1', customerName: 'First' })),
    store.transaction((transaction) => ensureEntry(transaction, { vin: 'VIN-1', ccmId: 'ccm-1', customerName: 'Second' })),
  ]);

  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].vin, 'VIN-1');
  assert.equal(store.entries[0].ccmId, 'ccm-1');
});

test('concurrent updates and a retry continue to update the same canonical MCL row', async () => {
  const store = createMclStore();
  await Promise.all(Array.from({ length: 5 }, (_, index) => (
    store.transaction((transaction) => ensureEntry(transaction, {
      vin: 'VIN-2',
      ccmId: 'ccm-1',
      customerName: `Import ${index}`,
    }))
  )));
  await store.transaction((transaction) => ensureEntry(transaction, {
    vin: 'VIN-2',
    ccmId: 'ccm-1',
    customerName: 'Retry',
  }));

  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].customerName, 'Retry');
});

test('retry after a transaction conflict safely recreates or updates one canonical row', async () => {
  const store = createMclStore();
  let attempts = 0;
  const runImport = () => store.transaction(async (transaction) => {
    const result = await ensureEntry(transaction, {
      vin: 'VIN-CONFLICT',
      ccmId: 'ccm-1',
      customerName: 'Retried import',
    });
    if (attempts++ === 0) {
      throw Object.assign(new Error('Simulated transaction conflict.'), { code: 'P2034' });
    }
    return result;
  });

  await assert.rejects(runImport, { code: 'P2034' });
  await runImport();

  assert.equal(attempts, 2);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].customerName, 'Retried import');
});

test('legacy MCL duplicates are preserved while display consolidation prefers an assigned stable row', () => {
  const assigned = {
    id: 'mcl-assigned',
    ccmId: 'ccm-1',
    vin: 'VIN-3',
    assigneeId: 'cre-1',
    createdAt: new Date('2026-02-01T00:00:00Z'),
  };
  const earlierUnassigned = {
    id: 'mcl-unassigned',
    ccmId: 'ccm-1',
    vin: 'VIN-3',
    assigneeId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const duplicates = [earlierUnassigned, assigned];

  const display = consolidateMasterCallListEntries(duplicates);

  assert.equal(display.length, 1);
  assert.equal(display[0].id, assigned.id);
  assert.equal(duplicates.length, 2);
});

test('allocation queue groups allocations by VIN/CCM and does not invent contact data or duplicate MCL rows', () => {
  const masterRecords = [{
    id: 'mcl-existing',
    vin: 'VIN-4',
    ccmId: 'ccm-1',
    assigneeId: null,
  }];
  const allocations = [
    { id: 'allocation-a', ccmId: 'ccm-1', serviceType: 'Service', vehicle: { id: 'vehicle-4', vin: 'VIN-4' } },
    { id: 'allocation-b', ccmId: 'ccm-1', serviceType: 'Warranty', vehicle: { id: 'vehicle-4', vin: 'VIN-4' } },
    {
      id: 'allocation-c',
      ccmId: 'ccm-1',
      serviceType: 'Service',
      vehicle: { id: 'vehicle-5', vin: 'VIN-5', customer: { id: 'customer-5' } },
    },
    { id: 'allocation-other-team', ccmId: 'ccm-2', serviceType: 'Service', vehicle: { id: 'vehicle-6', vin: 'VIN-6' } },
  ];

  const queue = buildAllocationQueueRecords(masterRecords, allocations, 'ccm-1');

  assert.equal(queue.length, 1);
  assert.equal(queue[0].allocationId, 'allocation-c');
  assert.equal(queue[0].ccmId, 'ccm-1');
  assert.equal(queue[0].vin, 'VIN-5');
  assert.equal(queue[0].name, null);
  assert.equal(queue[0].mobile, null);
  assert.equal(queue[0].customerId, 'customer-5');
});

test('CCM queue response includes existing-MCL and allocation-only vehicles without cross-team rows', () => {
  const records = [{
    id: 'mcl-existing',
    vin: 'VIN-MCL',
    ccmId: 'ccm-1',
    assigneeId: null,
    name: 'Existing customer',
    mobile: null,
  }];
  const allocations = [
    { id: 'allocation-mcl', ccmId: 'ccm-1', vehicle: { id: 'vehicle-mcl', vin: 'VIN-MCL' } },
    { id: 'allocation-only', ccmId: 'ccm-1', vehicle: { id: 'vehicle-only', vin: 'VIN-ONLY' } },
    { id: 'allocation-other-team', ccmId: 'ccm-2', vehicle: { id: 'vehicle-other', vin: 'VIN-OTHER' } },
  ];

  const queueRecords = includeUnassignedAllocationQueue(records, allocations, 'ccm-1');

  assert.equal(queueRecords.length, 2);
  assert.equal(queueRecords[0].id, 'mcl-existing');
  assert.equal(queueRecords[0].allocationQueue, true);
  assert.equal(queueRecords[0].name, 'Existing customer');
  assert.equal(queueRecords[1].vin, 'VIN-ONLY');
  assert.equal(queueRecords[1].allocationOnly, true);
  assert.ok(queueRecords.every((record) => record.ccmId === 'ccm-1'));
});

test('latest repair-order display ordering remains date, creation timestamp, then stable ID', () => {
  assert.deepEqual(latestWorkshopVisitOrderBy, [
    { visitDate: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
    { id: 'desc' },
  ]);
  const visitHistory = [
    { repairOrderNo: 'RO-LATEST', visitDate: new Date('2026-03-01T00:00:00Z') },
    { repairOrderNo: 'RO-OLDER', visitDate: new Date('2025-03-01T00:00:00Z') },
  ];
  const displayRecord = consolidateMasterCallListEntries([{
    id: 'mcl-latest',
    ccmId: 'ccm-1',
    vin: 'VIN-LATEST',
    assigneeId: null,
    workshopVisits: visitHistory,
  }])[0];
  assert.equal(displayRecord.workshopVisits[0].repairOrderNo, 'RO-LATEST');
  assert.equal(displayRecord.workshopVisits.length, 2);
});
