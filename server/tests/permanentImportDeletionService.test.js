import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PermanentImportDeletionConflict,
  permanentlyDeleteImportBatch,
  previewPermanentImportDeletion,
} from '../src/services/permanentImportDeletionService.js';
import { rollbackImportBatch } from '../src/services/importRollbackService.js';

function createEmptyImportDatabase() {
  const batch = {
    id: 'import-empty',
    fileName: 'rejected-rows.csv',
    status: 'completed',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    totalRows: 1,
    rollbackSupported: true,
    allocationEvidenceState: 'not_started',
    allocationChangeCount: 0,
    changes: [],
    rowProgress: [{
      id: 'progress-1',
      importBatchId: 'import-empty',
      rowNumber: 2,
      status: 'completed',
      outcome: 'rejected',
      mutationState: 'complete',
      loggedChangeCount: 0,
    }],
  };
  const auditLogs = [];
  const transaction = {
    $queryRaw: async () => [],
    importBatch: {
      findUnique: async () => batch,
      update: async ({ data }) => Object.assign(batch, data),
    },
    importRowProgress: { findMany: async () => batch.rowProgress },
    importChangeLog: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push(data);
        return data;
      },
    },
  };
  return {
    batch,
    auditLogs,
    database: {
      $transaction: async (callback) => callback(transaction),
    },
  };
}

test('permanent-deletion preview and confirmation retain an empty import audit and are idempotent', async () => {
  const { database, batch, auditLogs } = createEmptyImportDatabase();
  const preview = await previewPermanentImportDeletion(batch.id, database);

  assert.equal(preview.fileName, batch.fileName);
  assert.equal(preview.directlyAffectedRecords, 0);
  assert.equal(preview.totalRecordsDeleted, 0);
  assert.ok(preview.confirmationToken);

  const result = await permanentlyDeleteImportBatch(batch.id, 'admin-1', preview.confirmationToken, database);
  assert.equal(result.status, 'permanently_deleted');
  assert.equal(batch.status, 'permanently_deleted');
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].userId, 'admin-1');
  assert.equal(auditLogs[0].action, 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED');

  const retry = await permanentlyDeleteImportBatch(batch.id, 'admin-1', preview.confirmationToken, database);
  assert.equal(retry.alreadyDeleted, true);
  assert.equal(auditLogs.length, 1);
});

test('permanent deletion requires the preview confirmation token', async () => {
  const { database } = createEmptyImportDatabase();

  await assert.rejects(
    permanentlyDeleteImportBatch('import-empty', 'admin-1', '', database),
    PermanentImportDeletionConflict,
  );
});

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([field, expected]) => {
    if (field === 'OR') return expected.some((condition) => matchesWhere(row, condition));
    if (field === 'AND') return expected.every((condition) => matchesWhere(row, condition));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if (Object.hasOwn(expected, 'in')) return expected.in.includes(row[field]);
      if (Object.hasOwn(expected, 'not')) return row[field] !== expected.not;
    }
    return row[field] === expected;
  });
}

function createCascadeDatabase({ failAtDelete = '', missingRecordIds = [], includeUnrelated = false } = {}) {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  const targetBatchId = 'import-february';
  const laterBatchId = 'import-march-april';
  const customer = {
    id: 'customer-imported', customerCode: 'CUS-IMPORTED', fullName: 'Imported Customer',
    mobileNumber: '9000000000', alternatePhone: null, email: null, ccmId: 'ccm-1',
    createdAt: timestamp, updatedAt: timestamp,
  };
  const vehicle = {
    id: 'vehicle-imported', vin: 'VIN-IMPORTED', registrationNumber: 'REG-1', make: 'Hyundai',
    model: 'i20', variant: null, year: null, saleDate: null, status: 'ACTIVE',
    customerId: customer.id, ccmId: 'ccm-1', createdAt: timestamp, updatedAt: timestamp,
  };
  const visit = (id, repairOrderNo) => ({
    id, repairOrderNo, customerId: customer.id, vehicleId: vehicle.id, ccmId: 'ccm-1',
    totalLaborCost: null, totalPartsCost: null, totalAmount: null, visitDate: null,
    closingDate: null, gpDate: null, importedDetails: {}, createdAt: timestamp, updatedAt: timestamp,
  });
  const sharedCustomer = {
    id: 'customer-existing', customerCode: 'CUS-EXISTING', fullName: 'Changed Existing Customer',
    mobileNumber: '9111111111', alternatePhone: null, email: null, ccmId: 'ccm-1',
    createdAt: timestamp, updatedAt: new Date('2026-01-03T00:00:00.000Z'),
  };
  const oldSharedCustomerState = {
    fullName: 'Existing Customer',
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };
  const laterVisits = [visit('visit-march', 'RO-MARCH'), visit('visit-april', 'RO-APRIL')];
  const unrelatedCustomer = {
    id: 'customer-unrelated', customerCode: 'CUS-UNRELATED', fullName: 'Unrelated Customer',
    mobileNumber: '9222222222', alternatePhone: null, email: null, ccmId: 'ccm-2',
    createdAt: timestamp, updatedAt: timestamp,
  };
  const unrelatedVehicle = {
    id: 'vehicle-unrelated', vin: 'VIN-UNRELATED', registrationNumber: 'REG-UNRELATED', make: 'Hyundai',
    model: 'Venue', variant: null, year: null, saleDate: null, status: 'ACTIVE',
    customerId: unrelatedCustomer.id, ccmId: 'ccm-2', createdAt: timestamp, updatedAt: timestamp,
  };
  const unrelatedVisit = {
    ...visit('visit-unrelated', 'RO-UNRELATED'),
    customerId: unrelatedCustomer.id,
    vehicleId: unrelatedVehicle.id,
    ccmId: 'ccm-2',
  };
  const targetBatch = {
    id: targetBatchId, fileName: 'February.csv', status: 'completed', createdAt: timestamp,
    totalRows: 1, rollbackSupported: true, allocationEvidenceState: 'not_started',
    allocationChangeCount: 0,
  };
  const laterBatch = {
    id: laterBatchId, fileName: 'March-April.csv', status: 'completed',
    createdAt: new Date('2026-02-01T00:00:00.000Z'), totalRows: 2,
    rollbackSupported: true, allocationEvidenceState: 'not_started', allocationChangeCount: 0,
  };
  const targetProgress = {
    id: 'target-progress', importBatchId: targetBatchId, rowNumber: 2, status: 'completed',
    outcome: 'created', mutationState: 'complete', loggedChangeCount: 4,
  };
  const laterProgress = [
    { id: 'march-progress', importBatchId: laterBatchId, rowNumber: 2, status: 'completed', outcome: 'created', mutationState: 'complete', loggedChangeCount: 1 },
    { id: 'april-progress', importBatchId: laterBatchId, rowNumber: 3, status: 'completed', outcome: 'created', mutationState: 'complete', loggedChangeCount: 1 },
  ];
  const toSnapshot = (record) => Object.fromEntries(Object.entries(record).map(([field, value]) => [
    field,
    value instanceof Date ? value.toISOString() : value,
  ]));
  const makeChange = (batchId, rowProgressId, sequence, entityType, record, operation = 'CREATE', before = {}, after = toSnapshot(record)) => ({
    id: `${batchId}-change-${sequence}`,
    importBatchId: batchId,
    rowProgressId,
    evidenceScope: 'row',
    sequence,
    entityType,
    entityId: record.id,
    ccmId: 'ccm-1',
    operation,
    before,
    after,
    rollbackStatus: 'pending',
    createdAt: timestamp,
    rolledBackAt: null,
    rollbackError: null,
  });
  const targetChanges = [
    makeChange(targetBatchId, targetProgress.id, 1, 'Customer', customer),
    makeChange(targetBatchId, targetProgress.id, 2, 'Vehicle', vehicle),
    makeChange(targetBatchId, targetProgress.id, 3, 'WorkshopVisit', visit('visit-february', 'RO-FEBRUARY')),
    makeChange(
      targetBatchId,
      targetProgress.id,
      4,
      'Customer',
      sharedCustomer,
      'UPDATE',
      { fullName: oldSharedCustomerState.fullName, updatedAt: oldSharedCustomerState.updatedAt.toISOString() },
      { fullName: sharedCustomer.fullName, updatedAt: sharedCustomer.updatedAt.toISOString() },
    ),
  ];
  const laterChanges = laterVisits.map((record, index) => makeChange(
    laterBatchId,
    laterProgress[index].id,
    index + 1,
    'WorkshopVisit',
    record,
  ));
  targetBatch.changes = targetChanges;
  targetBatch.rowProgress = [targetProgress];
  laterBatch.changes = laterChanges;
  laterBatch.rowProgress = laterProgress;

  const state = {
    batches: [targetBatch, laterBatch],
    rowProgress: [targetProgress, ...laterProgress],
    changeLogs: [...targetChanges, ...laterChanges],
    auditLogs: [],
    deletionOrder: [],
    tables: {
      customer: [customer, sharedCustomer, ...(includeUnrelated ? [unrelatedCustomer] : [])].filter(({ id }) => !missingRecordIds.includes(id)),
      vehicle: [vehicle, ...(includeUnrelated ? [unrelatedVehicle] : [])].filter(({ id }) => !missingRecordIds.includes(id)),
      workshopVisit: [visit('visit-february', 'RO-FEBRUARY'), ...laterVisits, ...(includeUnrelated ? [unrelatedVisit] : [])].filter(({ id }) => !missingRecordIds.includes(id)),
      masterCallList: [{ id: 'call-list', vin: vehicle.vin, ccmId: 'ccm-1', updatedAt: timestamp }],
      allocation: [{ id: 'allocation', vehicleId: vehicle.id, ccmId: 'ccm-1', updatedAt: timestamp }],
      callLog: [{ id: 'call-log', customerId: customer.id, vehicleId: vehicle.id, createdAt: timestamp }],
      followUp: [{ id: 'follow-up', customerId: customer.id, vehicleId: vehicle.id, createdAt: timestamp, updatedAt: timestamp }],
      appointment: [{ id: 'appointment', customerId: customer.id, vehicleId: vehicle.id, createdAt: timestamp, updatedAt: timestamp }],
      appointmentEvent: [{ id: 'appointment-event', appointmentId: 'appointment', createdAt: timestamp }],
      vehicleOwnershipHistory: [{ id: 'ownership', vehicleId: vehicle.id, changedAt: timestamp }],
      freeServiceMilestone: [{ id: 'milestone', vehicleId: vehicle.id, updatedAt: timestamp }],
      monthlyCustomerDataEntry: [{ id: 'monthly-entry', customerId: customer.id, vehicleId: vehicle.id, createdAt: timestamp }],
      vINConflictReview: [{ id: 'vin-review', vin: vehicle.vin, createdAt: timestamp, updatedAt: timestamp }],
    },
  };
  const database = {
    $transaction: async (callback) => {
      const draft = structuredClone(state);
      const batches = new Map(draft.batches.map((batch) => [batch.id, batch]));
      const findRows = (tableName, where) => draft.tables[tableName].filter((row) => matchesWhere(row, where));
      const makeTableDelegate = (tableName) => ({
        findMany: async ({ where } = {}) => findRows(tableName, where).map((row) => structuredClone(row)),
        findUnique: async ({ where }) => structuredClone(draft.tables[tableName].find(({ id }) => id === where.id) || null),
        update: async ({ where, data }) => {
          const row = draft.tables[tableName].find(({ id }) => id === where.id);
          Object.assign(row, data);
          return structuredClone(row);
        },
        updateMany: async ({ where, data }) => {
          const rows = findRows(tableName, where);
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
        deleteMany: async ({ where }) => {
          if (failAtDelete === tableName) throw new Error(`Injected failure deleting ${tableName}.`);
          const rows = findRows(tableName, where);
          draft.tables[tableName] = draft.tables[tableName].filter((row) => !rows.includes(row));
          draft.deletionOrder.push(tableName);
          return { count: rows.length };
        },
      });
      const transaction = {
        $queryRaw: async () => [],
        importBatch: {
          findUnique: async ({ where }) => structuredClone(batches.get(where.id) || null),
          update: async ({ where, data }) => {
            const batch = batches.get(where.id);
            Object.assign(batch, data);
            return structuredClone(batch);
          },
        },
        importRowProgress: {
          findMany: async ({ where } = {}) => draft.rowProgress.filter((row) => matchesWhere(row, where)).map((row) => structuredClone(row)),
        },
        importChangeLog: {
          findMany: async ({ where = {}, include } = {}) => draft.changeLogs
            .filter((change) => matchesWhere(change, where))
            .map((change) => ({
              ...structuredClone(change),
              ...(include?.batch ? { batch: structuredClone(batches.get(change.importBatchId)) } : {}),
              ...(include?.rowProgress ? { rowProgress: structuredClone(draft.rowProgress.find(({ id }) => id === change.rowProgressId) || null) } : {}),
            })),
          updateMany: async ({ where, data }) => {
            const rows = draft.changeLogs.filter((change) => matchesWhere(change, where));
            for (const row of rows) Object.assign(row, data);
            for (const batch of draft.batches) {
              batch.changes = draft.changeLogs.filter(({ importBatchId }) => importBatchId === batch.id);
            }
            return { count: rows.length };
          },
        },
        auditLog: {
          create: async ({ data }) => {
            draft.auditLogs.push(data);
            return data;
          },
        },
      };
      for (const tableName of Object.keys(draft.tables)) transaction[tableName] = makeTableDelegate(tableName);
      const result = await callback(transaction);
      Object.assign(state, draft);
      return result;
    },
  };
  return { database, state, oldSharedCustomerState, targetBatch, laterBatch };
}

test('permanent deletion cascades dependent records, preserves shared customers, and invalidates later import history', async () => {
  const { database, state, oldSharedCustomerState, targetBatch, laterBatch } = createCascadeDatabase();
  const preview = await previewPermanentImportDeletion(targetBatch.id, database);

  assert.equal(preview.directlyAffectedRecords, 3);
  assert.equal(preview.dependentRecords, 11);
  assert.equal(preview.totalRecordsDeleted, 14);
  assert.equal(preview.laterImportBatchesAffected, 1);
  assert.equal(preview.existingRecordsRestored, 1);
  assert.equal(preview.affectedImportBatches[0].invalidatedChanges, 2);

  const result = await permanentlyDeleteImportBatch(targetBatch.id, 'admin-1', preview.confirmationToken, database);

  assert.equal(result.status, 'permanently_deleted');
  assert.equal(state.tables.customer.some(({ id }) => id === 'customer-imported'), false);
  assert.equal(state.tables.vehicle.length, 0);
  assert.equal(state.tables.workshopVisit.length, 0);
  assert.equal(state.tables.callLog.length, 0);
  assert.equal(state.tables.followUp.length, 0);
  assert.equal(state.tables.appointment.length, 0);
  assert.equal(state.tables.appointmentEvent.length, 0);
  assert.equal(state.tables.allocation.length, 0);
  assert.equal(state.tables.masterCallList.length, 0);
  assert.equal(state.tables.vehicleOwnershipHistory.length, 0);
  assert.equal(state.tables.freeServiceMilestone.length, 0);
  assert.equal(state.tables.vINConflictReview.length, 0);
  assert.deepEqual(state.tables.monthlyCustomerDataEntry[0], {
    id: 'monthly-entry', customerId: null, vehicleId: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const restoredCustomer = state.tables.customer.find(({ id }) => id === 'customer-existing');
  assert.equal(restoredCustomer.fullName, oldSharedCustomerState.fullName);
  assert.equal(restoredCustomer.updatedAt.toISOString(), oldSharedCustomerState.updatedAt.toISOString());
  assert.equal(state.batches.find(({ id }) => id === targetBatch.id).status, 'permanently_deleted');
  assert.equal(state.batches.find(({ id }) => id === laterBatch.id).status, 'completed');
  assert.ok(state.changeLogs.filter(({ importBatchId }) => importBatchId === laterBatch.id).every(({ rollbackStatus, rollbackError }) => (
    rollbackStatus === 'permanently_deleted' && rollbackError.includes(targetBatch.id)
  )));

  const laterRollback = await rollbackImportBatch(laterBatch.id, 'admin-1', database);
  assert.equal(laterRollback.batch.status, 'rolled_back');
  assert.equal(laterRollback.reversedChanges, 0);
  assert.equal(state.tables.workshopVisit.length, 0);
});

test('permanent deletion tolerates missing imported anchors and preserves unrelated records', async () => {
  const { database, state, targetBatch, laterBatch } = createCascadeDatabase({
    missingRecordIds: ['customer-imported', 'vehicle-imported'],
    includeUnrelated: true,
  });
  const preview = await previewPermanentImportDeletion(targetBatch.id, database);

  assert.deepEqual(preview.recordsAlreadyAbsent, [
    { entityType: 'Customer', entityId: 'customer-imported', operation: 'CREATE' },
    { entityType: 'Vehicle', entityId: 'vehicle-imported', operation: 'CREATE' },
  ]);
  assert.equal(preview.directlyAffectedRecords, 1);
  assert.ok(preview.totalRecordsDeleted > 0);

  const result = await permanentlyDeleteImportBatch(targetBatch.id, 'admin-1', preview.confirmationToken, database);

  assert.equal(result.status, 'permanently_deleted');
  assert.equal(state.tables.customer.some(({ id }) => id === 'customer-existing'), true);
  assert.equal(state.tables.customer.some(({ id }) => id === 'customer-unrelated'), true);
  assert.equal(state.tables.vehicle.some(({ id }) => id === 'vehicle-unrelated'), true);
  assert.deepEqual(state.tables.workshopVisit.map(({ id }) => id), ['visit-unrelated']);
  assert.equal(state.batches.find(({ id }) => id === targetBatch.id).status, 'permanently_deleted');
  assert.ok(state.changeLogs.filter(({ importBatchId }) => importBatchId === targetBatch.id)
    .every(({ rollbackStatus }) => rollbackStatus === 'permanently_deleted'));
  assert.ok(state.changeLogs.filter(({ importBatchId }) => importBatchId === laterBatch.id)
    .every(({ rollbackStatus }) => rollbackStatus === 'permanently_deleted'));
  assert.equal(state.auditLogs.filter(({ action }) => action === 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED').length, 1);

  const retry = await permanentlyDeleteImportBatch(targetBatch.id, 'admin-1', preview.confirmationToken, database);
  assert.equal(retry.alreadyDeleted, true);
  assert.equal(state.auditLogs.filter(({ action }) => action === 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED').length, 1);
});

test('a failed permanent deletion rolls back all earlier dependent deletes', async () => {
  const { database, state, targetBatch } = createCascadeDatabase({ failAtDelete: 'vehicle' });
  const originalState = structuredClone(state);
  const preview = await previewPermanentImportDeletion(targetBatch.id, database);

  await assert.rejects(
    permanentlyDeleteImportBatch(targetBatch.id, 'admin-1', preview.confirmationToken, database),
    /Injected failure deleting vehicle/,
  );
  assert.deepEqual(state, originalState);
});
