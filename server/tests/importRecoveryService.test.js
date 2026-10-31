import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportRecoveryConflict, recoverAbandonedImport } from '../src/services/importRecoveryService.js';

function createRecoveryDatabase({ batch }) {
  const state = structuredClone({ batch, auditLogs: [] });
  const transaction = {
    $queryRaw: async () => [{ status: state.batch.status }],
    importBatch: {
      findUnique: async () => state.batch,
      update: async ({ data }) => {
        state.batch = { ...state.batch, ...data };
        return state.batch;
      },
    },
    importRowProgress: {
      findMany: async () => state.batch.rowProgress,
      groupBy: async ({ by }) => {
        const groups = new Map();
        for (const row of state.batch.rowProgress) {
          const key = by.map((field) => row[field]).join('|');
          groups.set(key, (groups.get(key) || 0) + 1);
        }
        return [...groups.entries()].map(([key, count]) => {
          const values = key.split('|');
          return {
            ...Object.fromEntries(by.map((field, index) => [field, values[index]])),
            _count: { _all: count },
          };
        });
      },
      count: async ({ where }) => state.batch.rowProgress.filter((row) => row.status === where.status).length,
    },
    importChangeLog: {
      groupBy: async ({ by }) => [...new Map(state.batch.changes.map((change) => {
        const key = by.map((field) => change[field]).join('|');
        return [key, Object.fromEntries(by.map((field) => [field, change[field]]))];
      })).values()],
    },
    auditLog: {
      create: async ({ data }) => {
        state.auditLogs.push(data);
        return data;
      },
    },
  };
  return {
    state,
    database: { $transaction: async (callback) => callback(transaction) },
  };
}

function makeBatch({ rowStatuses = ['completed'], changes = [] } = {}) {
  const rowId = 'progress-1';
  return {
    id: 'batch-1',
    status: 'processing',
    totalRows: rowStatuses.length,
    rollbackSupported: false,
    allocationEvidenceState: 'not_started',
    allocationChangeCount: 0,
    rowProgress: rowStatuses.map((status, index) => ({
      id: `progress-${index + 1}`,
      importBatchId: 'batch-1',
      rowNumber: index + 2,
      status,
      outcome: status === 'completed' ? 'skipped' : null,
      mutationState: status === 'completed' ? 'complete' : 'pending',
      loggedChangeCount: 0,
    })),
    changes: changes.map((change, index) => ({
      importBatchId: 'batch-1',
      rowProgressId: change.evidenceScope === 'batch' ? null : rowId,
      evidenceScope: change.evidenceScope || 'row',
      sequence: index + 1,
      ...change,
    })),
  };
}

function fullCustomer(id) {
  return {
    id,
    customerCode: `CUS-${id}`,
    fullName: 'Customer',
    mobileNumber: '123',
    alternatePhone: null,
    email: null,
    ccmId: 'ccm-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

function fullVisit(id) {
  return {
    id,
    repairOrderNo: `RO-${id}`,
    normalizedRepairOrderNo: `RO-${id}`.toUpperCase(),
    customerId: 'customer-1',
    vehicleId: 'vehicle-1',
    ccmId: 'ccm-1',
    totalLaborCost: null,
    totalPartsCost: null,
    totalAmount: null,
    visitDate: null,
    closingDate: null,
    gpDate: null,
    importedDetails: {},
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

function acquireTestLock() {
  return async () => {};
}

test('complete abandoned imports recover as failed and become eligible for Admin rollback', async () => {
  const customer = { id: 'customer-1' };
  const { database, state } = createRecoveryDatabase({
    batch: makeBatch({
      changes: [
        { entityType: 'Customer', entityId: customer.id, operation: 'CREATE', before: {}, after: fullCustomer(customer.id) },
        { entityType: 'WorkshopVisit', entityId: 'visit-1', operation: 'CREATE', before: {}, after: fullVisit('visit-1') },
      ],
    }),
  });
  state.batch.rowProgress[0].outcome = 'created';
  state.batch.rowProgress[0].loggedChangeCount = 2;

  const result = await recoverAbandonedImport('batch-1', 'admin-1', database, acquireTestLock);
  assert.equal(result.status, 'failed');
  assert.equal(result.batch.rollbackSupported, true);
  assert.equal(result.batch.statsComplete, true);
  assert.equal(result.batch.affectedCountsComplete, true);
  assert.equal(result.batch.affectedCustomers, 1);
  assert.equal(state.auditLogs[0].action, 'REPAIR_ORDER_IMPORT_RECOVERED');
});

test('incomplete abandoned imports stay blocked and are not marked rollback-supported', async () => {
  const { database, state } = createRecoveryDatabase({
    batch: makeBatch({ rowStatuses: ['completed', 'pending'] }),
  });

  const result = await recoverAbandonedImport('batch-1', 'admin-1', database, acquireTestLock);
  assert.equal(result.status, 'recovery_blocked');
  assert.equal(result.batch.rollbackSupported, false);
  assert.equal(result.batch.statsComplete, false);
  assert.match(result.reason, /1 of 2 rows/);
  assert.equal(state.auditLogs[0].action, 'REPAIR_ORDER_IMPORT_RECOVERY_BLOCKED');
});

test('a live processing lock prevents recovery of an active import', async () => {
  const { database, state } = createRecoveryDatabase({
    batch: makeBatch(),
  });
  const activeLock = async () => null;

  await assert.rejects(
    recoverAbandonedImport('batch-1', 'admin-1', database, activeLock),
    ImportRecoveryConflict,
  );
  assert.equal(state.batch.status, 'processing');
  assert.equal(state.auditLogs.length, 0);
});

test('incomplete snapshots keep an otherwise completed import blocked', async () => {
  const { database, state } = createRecoveryDatabase({
    batch: makeBatch({
      changes: [{
        entityType: 'Vehicle',
        entityId: 'vehicle-1',
        operation: 'CREATE',
        before: {},
        after: { id: 'wrong-id' },
      }],
    }),
  });
  state.batch.rowProgress[0].outcome = 'created';
  state.batch.rowProgress[0].loggedChangeCount = 1;

  const result = await recoverAbandonedImport('batch-1', 'admin-1', database, acquireTestLock);
  assert.equal(result.status, 'recovery_blocked');
  assert.equal(state.batch.rollbackSupported, false);
  assert.match(result.reason, /snapshots are incomplete/i);
});

test('a completed mutation row with no linked change logs remains blocked', async () => {
  const { database, state } = createRecoveryDatabase({
    batch: makeBatch(),
  });
  state.batch.rowProgress[0].outcome = 'created';

  const result = await recoverAbandonedImport('batch-1', 'admin-1', database, acquireTestLock);
  assert.equal(result.status, 'recovery_blocked');
  assert.equal(state.batch.rollbackSupported, false);
});

test('a completed no-mutation skipped row can be recovered', async () => {
  const { database, state } = createRecoveryDatabase({ batch: makeBatch() });

  const result = await recoverAbandonedImport('batch-1', 'admin-1', database, acquireTestLock);
  assert.equal(result.status, 'failed');
  assert.equal(result.batch.rollbackSupported, true);
});

test('a mutation row with an incomplete logged change count remains blocked', async () => {
  const { database, state } = createRecoveryDatabase({
    batch: makeBatch({
      changes: [{
        entityType: 'WorkshopVisit',
        entityId: 'visit-1',
        operation: 'CREATE',
        before: {},
        after: fullVisit('visit-1'),
      }],
    }),
  });
  state.batch.rowProgress[0].outcome = 'created';
  state.batch.rowProgress[0].loggedChangeCount = 0;

  const result = await recoverAbandonedImport('batch-1', 'admin-1', database, acquireTestLock);
  assert.equal(result.status, 'recovery_blocked');
  assert.equal(state.batch.rollbackSupported, false);
});
