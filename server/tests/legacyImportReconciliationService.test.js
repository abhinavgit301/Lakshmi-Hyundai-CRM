import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupLegacyImport,
  LegacyImportReconciliationConflict,
  previewLegacyImportCleanup,
  previewLegacyImportReconciliation,
} from '../src/services/legacyImportReconciliationService.js';
import { importSnapshot } from '../src/utils/importChangeLog.js';

const batchId = 'legacy-batch';
const recordId = 'legacy-visit';
const importedAt = new Date('2024-01-01T00:00:00.000Z');

function fixture({
  dependencies = [],
  laterChange = false,
  missingEvidence = false,
  failDelete = '',
  createParents = false,
  unrelatedVisit = false,
  batchStatus = 'permanently_deleted',
  rollbackStatus = 'permanently_deleted',
  rollbackSupported = true,
  batchRollback = {},
} = {}) {
  const record = {
    id: recordId,
    repairOrderNo: 'RO-LEGACY-1',
    normalizedRepairOrderNo: 'RO-LEGACY-1',
    customerId: 'existing-customer',
    vehicleId: 'existing-vehicle',
    ccmId: 'ccm-1',
    totalLaborCost: 10,
    totalPartsCost: 20,
    totalAmount: 30,
    visitDate: null,
    closingDate: null,
    gpDate: null,
    importedDetails: null,
    createdAt: importedAt,
    updatedAt: importedAt,
  };
  const batch = {
    id: batchId,
    fileName: 'legacy.csv',
    status: batchStatus,
    createdAt: importedAt,
    processingStartedAt: importedAt,
    totalRows: 1,
    rollbackSupported,
    allocationEvidenceState: 'not_started',
    allocationChangeCount: 0,
    rolledBackAt: null,
    rollbackError: null,
    ...batchRollback,
  };
  const customer = {
    id: 'created-customer',
    customerCode: 'CREATED-CUSTOMER',
    fullName: 'Imported Customer',
    mobileNumber: null,
    alternatePhone: null,
    email: null,
    ccmId: 'ccm-1',
    createdAt: importedAt,
    updatedAt: importedAt,
  };
  const vehicle = {
    id: 'created-vehicle',
    vin: 'LEGACY-VIN',
    registrationNumber: null,
    make: 'Hyundai',
    model: 'i20',
    variant: null,
    year: null,
    saleDate: null,
    status: 'ACTIVE',
    customerId: customer.id,
    ccmId: 'ccm-1',
    createdAt: importedAt,
    updatedAt: importedAt,
  };
  if (createParents) {
    record.customerId = customer.id;
    record.vehicleId = vehicle.id;
  }
  const changeFor = (type, entity, sequence) => ({
    id: `legacy-change-${sequence}`,
    importBatchId: batchId,
    rowProgressId: 'legacy-row-1',
    evidenceScope: 'row',
    sequence,
    entityType: type,
    entityId: entity.id,
    operation: 'CREATE',
    before: {},
    after: importSnapshot(entity),
    rollbackStatus,
    rollbackError: rollbackStatus === 'pending' ? null : 'Invalidated by permanent deletion of import earlier-batch',
    createdAt: importedAt,
    rolledBackAt: rollbackStatus === 'pending' ? null : importedAt,
  });
  const changes = createParents
    ? [changeFor('Customer', customer, 1), changeFor('Vehicle', vehicle, 2), changeFor('WorkshopVisit', record, 3)]
    : [changeFor('WorkshopVisit', record, 1)];
  const rowProgress = {
    id: 'legacy-row-1',
    importBatchId: batchId,
    rowNumber: 1,
    status: 'completed',
    outcome: 'created',
    mutationState: 'complete',
    loggedChangeCount: changes.length,
  };
  const state = {
    batches: [batch],
    changes: missingEvidence ? [] : changes,
    rowProgress: [rowProgress],
    rowErrors: [],
    auditLogs: [],
    tables: {
      customer: createParents ? [customer] : [],
      vehicle: createParents ? [vehicle] : [],
      workshopVisit: unrelatedVisit
        ? [record, {
          ...record,
          id: 'unrelated-visit',
          repairOrderNo: 'RO-OTHER-1',
          normalizedRepairOrderNo: 'RO-OTHER-1',
          customerId: 'existing-customer',
          vehicleId: 'existing-vehicle',
        }]
        : [record],
      callLog: [],
      followUp: [],
      appointment: [],
      appointmentEvent: [],
      allocation: [],
      vehicleOwnershipHistory: [],
      monthlyCustomerDataEntry: [],
      freeServiceMilestone: dependencies,
      masterCallList: [],
      vINConflictReview: [],
    },
  };
  if (laterChange) {
    state.batches.push({
      ...batch,
      id: 'later-batch',
      status: 'completed',
      rollbackSupported: true,
    });
    state.changes.push({
      ...changes.at(-1),
      id: 'later-change',
      importBatchId: 'later-batch',
      rollbackStatus: 'pending',
      rollbackError: null,
    });
  }

  const matches = (row, where = {}) => Object.entries(where).every(([field, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected) return expected.in.includes(row[field]);
    return row[field] === expected;
  });
  const createTransaction = (transactionState) => {
    const tx = {
      $queryRaw: async () => [],
      $queryRawUnsafe: async () => [],
      importBatch: {
        findMany: async () => structuredClone(transactionState.batches),
        findUnique: async ({ where }) => structuredClone(transactionState.batches.find(({ id }) => id === where.id) || null),
      },
      importChangeLog: {
        findMany: async ({ where = {} } = {}) => transactionState.changes
          .filter((row) => matches(row, where))
          .map((row) => structuredClone(row)),
      },
      importRowProgress: {
        findMany: async ({ where = {} } = {}) => transactionState.rowProgress
          .filter((row) => matches(row, where))
          .map((row) => structuredClone(row)),
      },
      importRowError: {
        findMany: async () => structuredClone(transactionState.rowErrors),
      },
      auditLog: {
        findMany: async () => structuredClone(transactionState.auditLogs),
        create: async ({ data }) => {
          transactionState.auditLogs.push(data);
          return data;
        },
      },
    };
    for (const [delegate, rows] of Object.entries(transactionState.tables)) {
      tx[delegate] = {
        findMany: async ({ where = {} } = {}) => rows
          .filter((row) => matches(row, where))
          .map((row) => structuredClone(row)),
        findUnique: async ({ where }) => structuredClone(rows.find(({ id }) => id === where.id) || null),
        deleteMany: async ({ where }) => {
          if (failDelete === delegate) throw new Error(`Injected transactional delete failure for ${delegate}.`);
          const found = rows.filter((row) => matches(row, where));
          transactionState.tables[delegate] = rows.filter((row) => !found.includes(row));
          return { count: found.length };
        },
      };
    }
    return tx;
  };
  const database = {
    $transaction: async (callback) => {
      const draft = structuredClone(state);
      const result = await callback(createTransaction(draft));
      Object.assign(state, draft);
      return result;
    },
  };
  return { database, state };
}

test('reports historical evidence and exactly cleans an eligible retained CREATE record', async () => {
  const { database, state } = fixture({
    batchStatus: 'completed',
    rollbackStatus: 'pending',
    rollbackSupported: false,
  });
  const report = await previewLegacyImportReconciliation(database);
  assert.equal(report.batches.length, 1);
  assert.equal(report.batches[0].evidenceComplete, true);
  assert.equal(report.records[0].classification, 'verified_attributable');

  const preview = await previewLegacyImportCleanup(batchId, database);
  assert.deepEqual(preview.recordsToDelete.map(({ entityType, entityId }) => ({ entityType, entityId })), [
    { entityType: 'WorkshopVisit', entityId: recordId },
  ]);
  assert.ok(preview.confirmationToken);

  const result = await cleanupLegacyImport(batchId, 'admin-1', preview.confirmationToken, database);
  assert.equal(result.status, 'legacy_cleanup_completed');
  assert.deepEqual(state.tables.workshopVisit, []);
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].rollbackStatus, 'pending');
  assert.equal(state.batches[0].status, 'completed');
  assert.equal(state.auditLogs.length, 1);
});

test('invalidated CREATE evidence remains report-only even when its complete snapshot matches', async () => {
  const { database, state } = fixture();
  const report = await previewLegacyImportReconciliation(database);
  const recordReport = report.records.find(({ entityId }) => entityId === recordId);

  assert.equal(report.batches[0].evidenceComplete, true);
  assert.equal(recordReport.classification, 'invalidated_evidence');
  assert.equal(recordReport.currentState.id, recordId);
  assert.ok(recordReport.attributionBlockers.some(({ code }) => code === 'invalidated_evidence_not_authority'));

  const preview = await previewLegacyImportCleanup(batchId, database);
  assert.equal(preview.confirmationToken, null);
  assert.equal(preview.recordsToDelete.length, 0);
  assert.ok(preview.blockers.some(({ code }) => code === 'invalidated_evidence_not_authority'));
  assert.ok(state.tables.workshopVisit.some(({ id }) => id === recordId));
  assert.equal(state.changes[0].rollbackStatus, 'permanently_deleted');
});

test('inconsistent legacy batch and change-log statuses cannot authorize cleanup', async () => {
  const cases = [
    { batchStatus: 'permanently_deleted', rollbackStatus: 'pending' },
    { batchStatus: 'completed', rollbackStatus: 'permanently_deleted' },
    { batchStatus: 'rolled_back', rollbackStatus: 'rolled_back' },
  ];

  for (const statuses of cases) {
    const { database, state } = fixture(statuses);
    const preview = await previewLegacyImportCleanup(batchId, database);
    assert.equal(preview.confirmationToken, null);
    assert.ok(preview.blockers.some(({ code }) => code === 'invalidated_evidence_not_authority'));
    assert.ok(state.tables.workshopVisit.some(({ id }) => id === recordId));
  }
});

test('batch-level rollback metadata keeps otherwise valid CREATE evidence report-only', async () => {
  const cases = [
    { batchStatus: 'completed', batchRollback: { rolledBackAt: importedAt } },
    { batchStatus: 'completed', batchRollback: { rollbackError: 'Unverified rollback attempt.' } },
    { batchStatus: 'failed', batchRollback: { rolledBackAt: importedAt } },
    { batchStatus: 'failed', batchRollback: { rollbackError: 'Unverified rollback attempt.' } },
    {
      batchStatus: 'completed',
      batchRollback: { rolledBackAt: importedAt, rollbackError: 'Unverified rollback attempt.' },
    },
  ];

  for (const { batchStatus, batchRollback } of cases) {
    const { database, state } = fixture({
      batchStatus,
      rollbackStatus: 'pending',
      rollbackSupported: false,
      batchRollback,
    });
    const report = await previewLegacyImportReconciliation(database);
    const batchReport = report.batches.find(({ id }) => id === batchId);
    const recordReport = report.records.find(({ entityId }) => entityId === recordId);

    assert.equal(batchReport.rollbackMetadataInvalid, true);
    assert.equal(recordReport.classification, 'invalidated_evidence');
    assert.equal(recordReport.cleanupEligible, false);
    assert.equal(recordReport.currentState.id, recordId);
    assert.ok(recordReport.evidence.some((item) => item.includes('batch-level rollback metadata')));
    const metadataBlocker = recordReport.attributionBlockers.find(({ code }) => (
      code === 'batch_rollback_metadata_unverified'
    ));
    assert.ok(metadataBlocker);
    assert.equal(metadataBlocker.importBatchId, batchId);
    assert.match(metadataBlocker.message, /reversal cannot be independently verified/);

    const preview = await previewLegacyImportCleanup(batchId, database);
    assert.equal(preview.confirmationToken, null);
    assert.equal(preview.recordsToDelete.length, 0);
    assert.ok(preview.blockers.some(({ code, importBatchId }) => (
      code === 'batch_rollback_metadata_unverified' && importBatchId === batchId
    )));
    assert.ok(state.tables.workshopVisit.some(({ id }) => id === recordId));
  }
});

test('deletes only target-created customer, vehicle, and service history in dependency order', async () => {
  const { database, state } = fixture({
    createParents: true,
    unrelatedVisit: true,
    batchStatus: 'completed',
    rollbackStatus: 'pending',
    rollbackSupported: false,
  });
  const preview = await previewLegacyImportCleanup(batchId, database);
  assert.equal(preview.blockers.length, 0);
  assert.deepEqual(preview.recordsToDelete.map(({ entityType }) => entityType), [
    'WorkshopVisit',
    'Vehicle',
    'Customer',
  ]);
  const result = await cleanupLegacyImport(batchId, 'admin-1', preview.confirmationToken, database);
  assert.equal(result.deletedRecords.length, 3);
  assert.deepEqual(state.tables.customer, []);
  assert.deepEqual(state.tables.vehicle, []);
  assert.deepEqual(state.tables.workshopVisit.map(({ id }) => id), ['unrelated-visit']);
  assert.equal(state.changes.length, 3);
});

test('blocks incomplete evidence and records with downstream workflow references', async () => {
  const incomplete = fixture({ missingEvidence: true });
  const incompletePreview = await previewLegacyImportCleanup(batchId, incomplete.database);
  assert.equal(incompletePreview.confirmationToken, null);
  assert.ok(incompletePreview.blockers.some(({ code }) => code === 'no_verified_cleanup_candidates'));

  const dependent = fixture({
    dependencies: [{
      id: 'milestone-1',
      vehicleId: 'existing-vehicle',
      completedByRepairOrderNo: 'RO-LEGACY-1',
    }],
  });
  const dependentPreview = await previewLegacyImportCleanup(batchId, dependent.database);
  assert.equal(dependentPreview.confirmationToken, null);
  assert.ok(dependentPreview.blockers.some(({ code }) => code === 'unresolved_dependency'));
  assert.equal(dependent.state.tables.workshopVisit.length, 1);
});

test('blocks cleanup when another import also references the same entity', async () => {
  const { database, state } = fixture({ laterChange: true });
  const preview = await previewLegacyImportCleanup(batchId, database);
  assert.equal(preview.confirmationToken, null);
  assert.equal(preview.recordsToDelete.length, 0);
  assert.ok(state.tables.workshopVisit.length);
});

test('blocks a partial cleanup when the same legacy batch also contains an UPDATE', async () => {
  const { database, state } = fixture();
  const before = { fullName: 'Existing Name', updatedAt: importedAt.toISOString() };
  const after = { fullName: 'Imported Name', updatedAt: importedAt.toISOString() };
  state.tables.customer.push({
    id: 'existing-customer',
    customerCode: 'EXISTING-CUSTOMER',
    fullName: after.fullName,
    mobileNumber: null,
    alternatePhone: null,
    email: null,
    ccmId: 'ccm-1',
    createdAt: importedAt,
    updatedAt: importedAt,
  });
  state.changes.push({
    id: 'legacy-update-2',
    importBatchId: batchId,
    rowProgressId: 'legacy-row-1',
    evidenceScope: 'row',
    sequence: 2,
    entityType: 'Customer',
    entityId: 'existing-customer',
    operation: 'UPDATE',
    before: importSnapshot(before),
    after: importSnapshot(after),
    rollbackStatus: 'permanently_deleted',
    rollbackError: 'Invalidated by permanent deletion of import earlier-batch',
  });
  state.rowProgress[0].loggedChangeCount = 2;

  const preview = await previewLegacyImportCleanup(batchId, database);
  assert.equal(preview.confirmationToken, null);
  assert.ok(preview.blockers.some(({ code }) => code === 'update_reversal_unsupported'));
  assert.equal(state.tables.workshopVisit.length, 1);
});

test('rejects a stale preview after the target record changes', async () => {
  const { database, state } = fixture({
    batchStatus: 'completed',
    rollbackStatus: 'pending',
    rollbackSupported: false,
  });
  const preview = await previewLegacyImportCleanup(batchId, database);
  state.tables.workshopVisit[0].totalAmount = 999;
  await assert.rejects(
    cleanupLegacyImport(batchId, 'admin-1', preview.confirmationToken, database),
    LegacyImportReconciliationConflict,
  );
  assert.equal(state.tables.workshopVisit.length, 1);
  assert.equal(state.auditLogs.length, 0);
});

test('rolls back record deletion and audit evidence after an injected transaction failure', async () => {
  const { database, state } = fixture({
    createParents: true,
    failDelete: 'vehicle',
    batchStatus: 'completed',
    rollbackStatus: 'pending',
    rollbackSupported: false,
  });
  const preview = await previewLegacyImportCleanup(batchId, database);
  await assert.rejects(
    cleanupLegacyImport(batchId, 'admin-1', preview.confirmationToken, database),
    /Injected transactional delete failure for vehicle/,
  );
  assert.equal(state.tables.workshopVisit.length, 1);
  assert.equal(state.tables.vehicle.length, 1);
  assert.equal(state.tables.customer.length, 1);
  assert.equal(state.auditLogs.length, 0);
  assert.equal(state.changes.length, 3);
});
