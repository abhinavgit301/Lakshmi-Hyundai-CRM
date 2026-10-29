import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportRollbackConflict, rollbackImportBatch } from '../src/services/importRollbackService.js';

const rowId = 'progress-1';

function fullRecord(entityType, id, overrides = {}) {
  const timestamp = '2025-01-01T00:00:00.000Z';
  const defaults = {
    Customer: {
      customerCode: `CUS-${id}`, fullName: 'Customer', mobileNumber: '123', alternatePhone: null,
      email: null, ccmId: 'ccm-1',
    },
    Vehicle: {
      vin: `VIN-${id}`, registrationNumber: null, make: null, model: null, variant: null,
      year: null, saleDate: null, status: 'ACTIVE', customerId: 'customer-1', ccmId: 'ccm-1',
    },
    WorkshopVisit: {
      repairOrderNo: `RO-${id}`, customerId: 'customer-1', vehicleId: 'vehicle-1', ccmId: 'ccm-1',
      totalLaborCost: null, totalPartsCost: null, totalAmount: null, visitDate: null,
      closingDate: null, gpDate: null, importedDetails: {},
    },
    MasterCallList: {
      customerName: 'Customer', mobileNumber: '123', vin: `VIN-${id}`, registrationNumber: null,
      ccmId: 'ccm-1', ownerUserId: null, status: 'pending',
    },
    VINConflictReview: {
      vin: `VIN-${id}`, sourceCcmId: 'ccm-1', targetCcmId: 'ccm-2', reason: 'Conflict',
      status: 'pending', reviewNotes: null,
    },
  };
  return { id, ...defaults[entityType], createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

function createChange(entityType, record, overrides = {}) {
  return {
    entityType,
    entityId: record.id,
    operation: 'CREATE',
    before: {},
    after: record,
    ...overrides,
  };
}

function cloneTestValue(value) {
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(cloneTestValue);
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTestValue(item)]));
  }
  return value;
}

function createDatabase({ batch, records = {}, referenceCounts = {}, serializeTransactions = false }) {
  const state = cloneTestValue({ batch, records, auditLogs: [] });
  let transactionQueue = Promise.resolve();
  const transactionFor = (draft) => {
    const transaction = {
      $queryRaw: async () => [],
      importBatch: {
        findUnique: async () => ({
          ...draft.batch,
          changes: [...draft.batch.changes].sort((left, right) => right.sequence - left.sequence),
        }),
        update: async ({ data }) => {
          draft.batch = { ...draft.batch, ...data };
          return draft.batch;
        },
      },
      importRowProgress: {
        findMany: async () => draft.batch.rowProgress || [],
      },
      importChangeLog: {
        findMany: async () => draft.batch.changes,
        updateMany: async ({ where, data }) => {
          draft.batch.changes = draft.batch.changes.map((change) => (
            where.importBatchId === draft.batch.id && change.rollbackStatus === where.rollbackStatus
              ? { ...change, ...data }
              : change
          ));
          return { count: draft.batch.changes.length };
        },
      },
      auditLog: {
        create: async ({ data }) => {
          draft.auditLogs.push(data);
          return data;
        },
      },
    };

    for (const [entityType, delegateName] of Object.entries({
      Customer: 'customer',
      Vehicle: 'vehicle',
      WorkshopVisit: 'workshopVisit',
      MasterCallList: 'masterCallList',
      Allocation: 'allocation',
      VINConflictReview: 'vINConflictReview',
    })) {
      transaction[delegateName] = {
        findUnique: async ({ where }) => draft.records[entityType]?.[where.id] || null,
        delete: async ({ where }) => {
          const record = draft.records[entityType]?.[where.id];
          delete draft.records[entityType]?.[where.id];
          return record;
        },
        update: async ({ where, data }) => {
          draft.records[entityType][where.id] = { ...draft.records[entityType][where.id], ...data };
          return draft.records[entityType][where.id];
        },
        count: async () => referenceCounts[delegateName] || 0,
      };
    }
    for (const delegateName of [
      'callLog',
      'followUp',
      'appointment',
      'monthlyCustomerDataEntry',
      'vehicleOwnershipHistory',
      'freeServiceMilestone',
    ]) {
      transaction[delegateName] = { count: async () => referenceCounts[delegateName] || 0 };
    }
    return transaction;
  };

  return {
    state,
    database: {
      $transaction: async (callback) => {
        if (serializeTransactions) {
          const transaction = transactionQueue.then(() => runTransaction(callback));
          transactionQueue = transaction.catch(() => {});
          return transaction;
        }
        return runTransaction(callback);
      },
    },
  };

  async function runTransaction(callback) {
    const draft = cloneTestValue(state);
    const result = await callback(transactionFor(draft));
    Object.assign(state, draft);
    return result;
  }
}

function makeBatch({ status = 'completed', rollbackSupported = true, changes = [], outcome } = {}) {
  const rowOutcome = outcome || (changes.some(({ entityType, operation }) => entityType === 'WorkshopVisit' && operation === 'CREATE')
    ? 'created'
    : changes.some(({ entityType }) => entityType === 'VINConflictReview') ? 'flagged' : 'skipped');
  return {
    id: 'batch-1',
    status,
    rollbackSupported,
    allocationEvidenceState: changes.some(({ evidenceScope }) => evidenceScope === 'batch') ? 'complete' : 'not_started',
    allocationChangeCount: changes.filter(({ evidenceScope }) => evidenceScope === 'batch').length,
    totalRows: 1,
    rowProgress: [{
      id: rowId,
      importBatchId: 'batch-1',
      rowNumber: 2,
      status: 'completed',
      outcome: rowOutcome,
      mutationState: 'complete',
      loggedChangeCount: changes.filter(({ evidenceScope }) => evidenceScope !== 'batch').length,
    }],
    changes: changes.map((change, index) => ({
      importBatchId: 'batch-1',
      rowProgressId: change.evidenceScope === 'batch' ? null : rowId,
      evidenceScope: change.evidenceScope || 'row',
      sequence: index + 1,
      rollbackStatus: 'pending',
      ...change,
    })),
  };
}

function visitChange(id = 'visit-1', overrides = {}) {
  const record = fullRecord('WorkshopVisit', id);
  return { change: createChange('WorkshopVisit', record, overrides), record };
}

test('rollback removes a tracked import-created repair order and audits the operation', async () => {
  const { change, record } = visitChange();
  const { database, state } = createDatabase({
    batch: makeBatch({ changes: [change] }),
    records: { WorkshopVisit: { [record.id]: record } },
  });

  const result = await rollbackImportBatch('batch-1', 'admin-1', database);

  assert.equal(result.batch.status, 'rolled_back');
  assert.equal(result.reversedChanges, 1);
  assert.equal(state.records.WorkshopVisit[record.id], undefined);
  assert.equal(state.auditLogs[0].userId, 'admin-1');
  assert.equal(state.auditLogs[0].action, 'REPAIR_ORDER_IMPORT_ROLLED_BACK');
});

test('a completed mutation row with no linked logs is not rollback-eligible', async () => {
  const { database, state } = createDatabase({
    batch: makeBatch({ outcome: 'created' }),
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.batch.status, 'completed');
});

test('a completed skipped row with explicit no-mutation evidence is safely reversible as a no-op', async () => {
  const { database, state } = createDatabase({ batch: makeBatch({ outcome: 'skipped' }) });

  const result = await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(result.batch.status, 'rolled_back');
  assert.equal(result.reversedChanges, 0);
});

test('a mutation row with a missing log count remains blocked', async () => {
  const { change, record } = visitChange();
  const batch = makeBatch({ changes: [change] });
  batch.rowProgress[0].loggedChangeCount = 0;
  const { database, state } = createDatabase({
    batch,
    records: { WorkshopVisit: { [record.id]: record } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.records.WorkshopVisit[record.id].id, record.id);
});

test('legacy imports without change snapshots cannot be rolled back', async () => {
  const { database, state } = createDatabase({
    batch: makeBatch({ rollbackSupported: false }),
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.batch.status, 'completed');
});

test('legacy batches with stale rollback flags are blocked without complete progress', async () => {
  const { database, state } = createDatabase({
    batch: { ...makeBatch(), rowProgress: [], rollbackSupported: true },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.batch.status, 'completed');
});

test('a truncated CREATE snapshot is rejected before deleting a record', async () => {
  const record = fullRecord('WorkshopVisit', 'visit-truncated');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [createChange('WorkshopVisit', record, { after: { id: record.id } })],
    }),
    records: { WorkshopVisit: { [record.id]: record } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.ok(state.records.WorkshopVisit[record.id]);
});

test('an edit to any field in a full CREATE snapshot blocks deletion', async () => {
  const record = fullRecord('WorkshopVisit', 'visit-edited');
  const snapshot = fullRecord('WorkshopVisit', record.id);
  const { database, state } = createDatabase({
    batch: makeBatch({ changes: [createChange('WorkshopVisit', snapshot)] }),
    records: { WorkshopVisit: { [record.id]: { ...record, totalPartsCost: 45 } } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.records.WorkshopVisit[record.id].totalPartsCost, 45);
});

test('a repair order depending on an imported customer and vehicle blocks their deletion', async () => {
  const customer = fullRecord('Customer', 'customer-a');
  const vehicle = fullRecord('Vehicle', 'vehicle-a', { customerId: customer.id });
  const importedVisit = fullRecord('WorkshopVisit', 'visit-a', { customerId: customer.id, vehicleId: vehicle.id });
  const laterVisit = fullRecord('WorkshopVisit', 'visit-b', { customerId: customer.id, vehicleId: vehicle.id });
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        createChange('Customer', customer),
        createChange('Vehicle', vehicle),
        createChange('WorkshopVisit', importedVisit),
      ],
    }),
    records: {
      Customer: { [customer.id]: customer },
      Vehicle: { [vehicle.id]: vehicle },
      WorkshopVisit: { [importedVisit.id]: importedVisit, [laterVisit.id]: laterVisit },
    },
    referenceCounts: { workshopVisit: 1 },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.ok(state.records.Customer[customer.id]);
  assert.ok(state.records.Vehicle[vehicle.id]);
  assert.ok(state.records.WorkshopVisit[laterVisit.id]);
  assert.equal(state.batch.status, 'completed');
});

test('a later customer phone update is not overwritten by rollback', async () => {
  const customer = fullRecord('Customer', 'customer-phone', { mobileNumber: '333' });
  const { change: visitLog, record: visit } = visitChange('visit-phone');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        visitLog,
        { entityType: 'Customer', entityId: customer.id, operation: 'UPDATE', before: { mobileNumber: '111', updatedAt: '2025-01-01T00:00:00.000Z' }, after: { mobileNumber: '222', updatedAt: '2025-01-02T00:00:00.000Z' } },
      ],
    }),
    records: { Customer: { [customer.id]: customer }, WorkshopVisit: { [visit.id]: visit } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.records.Customer[customer.id].mobileNumber, '333');
});

test('a later manual edit of an import-tracked field blocks rollback', async () => {
  const customer = fullRecord('Customer', 'customer-manual', { mobileNumber: 'manual-value' });
  const { change: visitLog, record: visit } = visitChange('visit-manual');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        visitLog,
        { entityType: 'Customer', entityId: customer.id, operation: 'UPDATE', before: { mobileNumber: 'original', updatedAt: '2025-01-01T00:00:00.000Z' }, after: { mobileNumber: 'imported', updatedAt: '2025-01-02T00:00:00.000Z' } },
      ],
    }),
    records: { Customer: { [customer.id]: customer }, WorkshopVisit: { [visit.id]: visit } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.records.Customer[customer.id].mobileNumber, 'manual-value');
});

test('rollback compares decimal fields against JSON change-log snapshots', async () => {
  const visit = fullRecord('WorkshopVisit', 'visit-decimal', { totalAmount: { toJSON: () => '125.50' } });
  const snapshot = fullRecord('WorkshopVisit', visit.id, { totalAmount: '125.50' });
  const { database, state } = createDatabase({
    batch: makeBatch({ changes: [createChange('WorkshopVisit', snapshot)] }),
    records: { WorkshopVisit: { [visit.id]: visit } },
  });

  await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(state.records.WorkshopVisit[visit.id], undefined);
});

test('full CREATE snapshots compare timestamp and nullable fields after JSON serialization', async () => {
  const timestamp = '2024-06-15T10:30:00.000Z';
  const snapshot = fullRecord('WorkshopVisit', 'visit-dates', {
    visitDate: timestamp,
    closingDate: null,
  });
  const record = fullRecord('WorkshopVisit', 'visit-dates', {
    visitDate: new Date(timestamp),
    closingDate: null,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
  });
  const { database, state } = createDatabase({
    batch: makeBatch({ changes: [createChange('WorkshopVisit', snapshot)] }),
    records: { WorkshopVisit: { [record.id]: record } },
  });

  await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(state.records.WorkshopVisit[record.id], undefined);
});

test('rollback restores a batch-scoped tracked CRE allocation only if its assignment has not since changed', async () => {
  const allocation = { id: 'allocation-1', creId: 'cre-b' };
  const { database, state } = createDatabase({
    batch: makeBatch({
      outcome: 'skipped',
      changes: [{
        evidenceScope: 'batch',
        entityType: 'Allocation',
        entityId: allocation.id,
        operation: 'UPDATE',
        before: { creId: 'cre-a', updatedAt: '2025-01-01T00:00:00.000Z' },
        after: { creId: 'cre-b', updatedAt: '2025-01-02T00:00:00.000Z' },
      }],
    }),
    records: { Allocation: { [allocation.id]: { ...allocation, updatedAt: '2025-01-02T00:00:00.000Z' } } },
  });

  await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(state.records.Allocation[allocation.id].creId, 'cre-a');
});

test('a later call-list owner assignment is preserved and blocks conflicting rollback', async () => {
  const entry = fullRecord('MasterCallList', 'call-list-1', { ownerUserId: 'cre-c' });
  const { change: visitLog, record: visit } = visitChange('visit-call-list');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        visitLog,
        { entityType: 'MasterCallList', entityId: entry.id, operation: 'UPDATE', before: { ownerUserId: null, updatedAt: '2025-01-01T00:00:00.000Z' }, after: { ownerUserId: 'cre-a', updatedAt: '2025-01-02T00:00:00.000Z' } },
      ],
    }),
    records: { MasterCallList: { [entry.id]: entry }, WorkshopVisit: { [visit.id]: visit } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.records.MasterCallList[entry.id].ownerUserId, 'cre-c');
});

test('rollback reverses an import-created call-list entry assigned by the batch allocation pass', async () => {
  const entry = fullRecord('MasterCallList', 'call-list-created');
  const assignedEntry = { ...entry, ownerUserId: 'cre-a', updatedAt: '2025-01-02T00:00:00.000Z' };
  const { change: visitLog, record: visit } = visitChange('visit-for-call-list');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        visitLog,
        createChange('MasterCallList', entry),
        {
          evidenceScope: 'batch',
          entityType: 'MasterCallList',
          entityId: entry.id,
          operation: 'UPDATE',
          before: { ownerUserId: null, updatedAt: entry.updatedAt },
          after: { ownerUserId: 'cre-a', updatedAt: assignedEntry.updatedAt },
        },
      ],
    }),
    records: { MasterCallList: { [entry.id]: assignedEntry }, WorkshopVisit: { [visit.id]: visit } },
  });

  await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(state.records.MasterCallList[entry.id], undefined);
  assert.equal(state.records.WorkshopVisit[visit.id], undefined);
});

test('rollback restores a vehicle created by an earlier row and updated by a later row', async () => {
  const originalVehicle = fullRecord('Vehicle', 'vehicle-imported', { saleDate: null });
  const finalVehicle = {
    ...originalVehicle,
    saleDate: '2025-02-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  };
  const firstVisit = fullRecord('WorkshopVisit', 'visit-row-one', { vehicleId: originalVehicle.id });
  const secondVisit = fullRecord('WorkshopVisit', 'visit-row-two', { vehicleId: originalVehicle.id });
  const batch = {
    ...makeBatch(),
    totalRows: 2,
    rowProgress: [
      { id: 'progress-1', importBatchId: 'batch-1', rowNumber: 2, status: 'completed', outcome: 'created', mutationState: 'complete', loggedChangeCount: 2 },
      { id: 'progress-2', importBatchId: 'batch-1', rowNumber: 3, status: 'completed', outcome: 'appended', mutationState: 'complete', loggedChangeCount: 2 },
    ],
    changes: [
      { entityType: 'Vehicle', entityId: originalVehicle.id, operation: 'CREATE', before: {}, after: originalVehicle },
      { entityType: 'WorkshopVisit', entityId: firstVisit.id, operation: 'CREATE', before: {}, after: firstVisit },
      { entityType: 'Vehicle', entityId: originalVehicle.id, operation: 'UPDATE', before: { saleDate: null, updatedAt: originalVehicle.updatedAt }, after: { saleDate: finalVehicle.saleDate, updatedAt: finalVehicle.updatedAt } },
      { entityType: 'WorkshopVisit', entityId: secondVisit.id, operation: 'CREATE', before: {}, after: secondVisit },
    ].map((change, index) => ({
      importBatchId: 'batch-1',
      rowProgressId: index < 2 ? 'progress-1' : 'progress-2',
      evidenceScope: 'row',
      sequence: index + 1,
      rollbackStatus: 'pending',
      ...change,
    })),
  };
  const { database, state } = createDatabase({
    batch,
    records: {
      Vehicle: { [finalVehicle.id]: finalVehicle },
      WorkshopVisit: { [firstVisit.id]: firstVisit, [secondVisit.id]: secondVisit },
    },
  });

  await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(state.records.Vehicle[originalVehicle.id], undefined);
  assert.equal(state.records.WorkshopVisit[firstVisit.id], undefined);
  assert.equal(state.records.WorkshopVisit[secondVisit.id], undefined);
});

test('multiple updates to one entity unwind in reverse order and restore each prior timestamp', async () => {
  const original = fullRecord('Vehicle', 'vehicle-multi-update', { saleDate: null });
  const firstUpdateAt = '2025-01-02T00:00:00.000Z';
  const secondUpdateAt = '2025-01-03T00:00:00.000Z';
  const final = { ...original, saleDate: '2025-02-01T00:00:00.000Z', updatedAt: secondUpdateAt };
  const { change: visitLog, record: visit } = visitChange('visit-multi-update');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        visitLog,
        { entityType: 'Vehicle', entityId: original.id, operation: 'UPDATE', before: { saleDate: null, updatedAt: original.updatedAt }, after: { saleDate: '2025-01-15T00:00:00.000Z', updatedAt: firstUpdateAt } },
        { entityType: 'Vehicle', entityId: original.id, operation: 'UPDATE', before: { saleDate: '2025-01-15T00:00:00.000Z', updatedAt: firstUpdateAt }, after: { saleDate: final.saleDate, updatedAt: secondUpdateAt } },
      ],
    }),
    records: { Vehicle: { [original.id]: final }, WorkshopVisit: { [visit.id]: visit } },
  });

  await rollbackImportBatch('batch-1', 'admin-1', database);
  assert.equal(state.records.Vehicle[original.id].saleDate, null);
  assert.equal(state.records.Vehicle[original.id].updatedAt.toISOString(), original.updatedAt);
});

test('a later manual vehicle edit blocks CREATE then UPDATE rollback without changing the state', async () => {
  const original = fullRecord('Vehicle', 'vehicle-manual-edit', { saleDate: null });
  const { change: visitLog, record: visit } = visitChange('visit-manual-vehicle');
  const batch = makeBatch({
    changes: [
      visitLog,
      { entityType: 'Vehicle', entityId: original.id, operation: 'CREATE', before: {}, after: original },
      { entityType: 'Vehicle', entityId: original.id, operation: 'UPDATE', before: { saleDate: null, updatedAt: original.updatedAt }, after: { saleDate: '2025-01-15T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z' } },
    ],
  });
  const edited = { ...original, saleDate: '2025-03-01T00:00:00.000Z', updatedAt: '2025-01-03T00:00:00.000Z' };
  const { database, state } = createDatabase({
    batch,
    records: { Vehicle: { [original.id]: edited }, WorkshopVisit: { [visit.id]: visit } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.records.Vehicle[original.id].saleDate, edited.saleDate);
  assert.deepEqual(state.records.WorkshopVisit[visit.id], visit);
  assert.equal(state.batch.status, 'completed');
});

test('a fake transaction failure after one reverse step leaves all fake state unchanged', async () => {
  const { change: visitLog, record: visit } = visitChange('visit-atomic');
  const missingVehicle = fullRecord('Vehicle', 'missing-vehicle');
  const { database, state } = createDatabase({
    batch: makeBatch({
      changes: [
        createChange('Vehicle', missingVehicle),
        visitLog,
      ],
    }),
    records: { WorkshopVisit: { [visit.id]: visit } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.ok(state.records.WorkshopVisit[visit.id]);
  assert.equal(state.batch.status, 'completed');
  assert.equal(state.batch.changes[0].rollbackStatus, 'pending');
});

test('concurrent fake rollback attempts result in one succeeding', async () => {
  const { change, record } = visitChange();
  const { database, state } = createDatabase({
    serializeTransactions: true,
    batch: makeBatch({ changes: [change] }),
    records: { WorkshopVisit: { [record.id]: record } },
  });

  const results = await Promise.allSettled([
    rollbackImportBatch('batch-1', 'admin-1', database),
    rollbackImportBatch('batch-1', 'admin-2', database),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(state.batch.status, 'rolled_back');
  assert.equal(state.records.WorkshopVisit[record.id], undefined);
});

test('processing imports cannot be rolled back', async () => {
  const { database, state } = createDatabase({
    batch: makeBatch({ status: 'processing' }),
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.equal(state.batch.status, 'processing');
});

test('logs linked to a different or missing row are rejected', async () => {
  const { change, record } = visitChange();
  const batch = makeBatch({ changes: [change] });
  batch.changes[0].rowProgressId = null;
  const { database, state } = createDatabase({
    batch,
    records: { WorkshopVisit: { [record.id]: record } },
  });

  await assert.rejects(rollbackImportBatch('batch-1', 'admin-1', database), ImportRollbackConflict);
  assert.ok(state.records.WorkshopVisit[record.id]);
});
