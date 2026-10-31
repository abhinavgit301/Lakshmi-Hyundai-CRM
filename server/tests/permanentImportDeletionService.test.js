import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PermanentImportDeletionConflict,
  permanentlyDeleteImportBatch,
  previewPermanentImportDeletion,
} from '../src/services/permanentImportDeletionService.js';
import { importSnapshot } from '../src/utils/importChangeLog.js';

const targetId = 'import-target';
const laterId = 'import-later';
const fixedDate = new Date('2026-01-01T00:00:00.000Z');

function record(type, id, fields = {}) {
  const common = { id, ccmId: 'ccm-test', createdAt: fixedDate, updatedAt: fixedDate, ...fields };
  if (type === 'Customer') {
    return {
      customerCode: `${id}-code`,
      fullName: `${id} name`,
      mobileNumber: '9000000000',
      alternatePhone: null,
      email: null,
      ...common,
    };
  }
  if (type === 'Vehicle') {
    return {
      vin: `${id}-vin`,
      physicalVehicleId: 'physical-test',
      registrationNumber: `${id}-reg`,
      make: 'Hyundai',
      model: 'i20',
      variant: null,
      year: null,
      saleDate: null,
      status: 'ACTIVE',
      customerId: 'customer-existing',
      ...common,
    };
  }
  if (type === 'WorkshopVisit') {
    const repairOrderNo = `${id}-ro`;
    return {
      repairOrderNo,
      normalizedRepairOrderNo: String(fields.repairOrderNo ?? repairOrderNo).trim().replace(/\s+/g, ' ').toUpperCase(),
      customerId: 'customer-existing',
      vehicleId: 'vehicle-existing',
      physicalVehicleId: 'physical-test',
      totalLaborCost: null,
      totalPartsCost: null,
      totalAmount: null,
      visitDate: null,
      closingDate: null,
      gpDate: null,
      importedDetails: { source: 'test', flags: [1, null, true] },
      ...common,
    };
  }
  return common;
}

function change(batchId, sequence, entityType, entityId, operation, before, after, rowProgressId = `${batchId}-row`) {
  return {
    id: `${batchId}-change-${sequence}`,
    importBatchId: batchId,
    rowProgressId,
    evidenceScope: 'row',
    sequence,
    entityType,
    entityId,
    ccmId: 'ccm-test',
    operation,
    before: importSnapshot(before),
    after: importSnapshot(after),
    rollbackStatus: 'pending',
    createdAt: fixedDate,
    rolledBackAt: null,
    rollbackError: null,
  };
}

function batch(id, createdAt = fixedDate) {
  return {
    id,
    fileName: `${id}.csv`,
    status: 'completed',
    createdAt,
    processingStartedAt: fixedDate,
    totalRows: 1,
    rollbackSupported: true,
    allocationEvidenceState: 'not_started',
    allocationChangeCount: 0,
    statsComplete: true,
    affectedCountsComplete: true,
    createdRows: 0,
    appendedRows: 0,
    affectedCustomers: 0,
    affectedVehicles: 0,
    affectedRepairOrders: 0,
    affectedCallListEntries: 0,
    affectedAllocations: 0,
    affectedMonthlyEntries: 0,
    importType: 'repair_order',
    rolledBackAt: null,
    rollbackError: null,
  };
}

function createDatabase({
  targetChanges = [],
  laterChanges = [],
  targetRecords = {},
  laterCreatedAt = new Date('2026-02-01T00:00:00.000Z'),
  laterBatchStatus = 'completed',
  targetBatchRollback = {},
  laterBatchRollback = {},
  workflows = {},
  failAtDelete = '',
  emptyImport = false,
} = {}) {
  const targetBatch = batch(targetId);
  if (emptyImport) targetBatch.totalRows = 0;
  const laterBatch = batch(laterId, laterCreatedAt);
  laterBatch.status = laterBatchStatus;
  Object.assign(targetBatch, targetBatchRollback);
  Object.assign(laterBatch, laterBatchRollback);
  const rowProgress = [];
  const targetChangesByRow = new Map();
  for (const changeLog of targetChanges) {
    const rowId = changeLog.rowProgressId || `${targetId}-row`;
    const rowChanges = targetChangesByRow.get(rowId) || [];
    rowChanges.push(changeLog);
    targetChangesByRow.set(rowId, rowChanges);
  }
  if (emptyImport) {
    targetBatch.totalRows = 0;
  } else if (targetChangesByRow.size) {
    targetBatch.totalRows = targetChangesByRow.size;
    for (const [index, [rowId, rowChanges]] of [...targetChangesByRow].entries()) {
      rowProgress.push({
        id: rowId,
        importBatchId: targetId,
        rowNumber: index + 2,
        status: 'completed',
        outcome: 'created',
        mutationState: 'complete',
        loggedChangeCount: rowChanges.length,
      });
    }
  } else {
    rowProgress.push({
      id: `${targetId}-row`,
      importBatchId: targetId,
      rowNumber: 2,
      status: 'completed',
      outcome: 'rejected',
      mutationState: 'complete',
      loggedChangeCount: 0,
    });
  }
  const changes = [...targetChanges, ...laterChanges];
  const laterGroups = new Map();
  for (const changeLog of laterChanges) {
    const group = laterGroups.get(changeLog.importBatchId) || [];
    group.push(changeLog);
    laterGroups.set(changeLog.importBatchId, group);
  }
  for (const [batchId, batchChanges] of laterGroups) {
    const hasVisitCreate = batchChanges.some(({ entityType, operation }) => (
      entityType === 'WorkshopVisit' && operation === 'CREATE'
    ));
    if (!hasVisitCreate) {
      const sequence = Math.max(...batchChanges.map(({ sequence }) => sequence), 0) + 1;
      changes.push(makeCreate(
        'WorkshopVisit',
        record('WorkshopVisit', `${batchId}-evidence-visit`),
        sequence,
        batchId,
      ));
    }
    rowProgress.push({
      id: `${batchId}-row`,
      importBatchId: batchId,
      rowNumber: 2,
      status: 'completed',
      outcome: 'created',
      mutationState: 'complete',
      loggedChangeCount: changes.filter(({ importBatchId }) => importBatchId === batchId).length,
    });
  }
  const state = {
    batches: [targetBatch, laterBatch],
    tables: {
      customer: targetRecords.Customer || [],
      vehicle: targetRecords.Vehicle || [],
      workshopVisit: targetRecords.WorkshopVisit || [],
      masterCallList: targetRecords.MasterCallList || [],
      allocation: targetRecords.Allocation || [],
      vINConflictReview: targetRecords.VINConflictReview || [],
      callLog: workflows.callLog || [],
      followUp: workflows.followUp || [],
      appointment: workflows.appointment || [],
      vehicleOwnershipHistory: workflows.vehicleOwnershipHistory || [],
      monthlyCustomerDataEntry: workflows.monthlyCustomerDataEntry || [],
      freeServiceMilestone: workflows.freeServiceMilestone || [],
      monthlyCustomerDataset: [],
      physicalVehicle: targetRecords.PhysicalVehicle || [],
    },
    rowProgress,
    changeLogs: changes,
    auditLogs: [],
    deletionOrder: [],
    recordFindUniqueCalls: [],
  };
  const transactionOptions = [];

  function matchesWhere(row, where = {}) {
    return Object.entries(where).every(([field, expected]) => {
      if (field === 'OR') return expected.some((condition) => matchesWhere(row, condition));
      if (field === 'AND') return expected.every((condition) => matchesWhere(row, condition));
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if (Object.hasOwn(expected, 'in')) return expected.in.includes(row[field]);
        if (Object.hasOwn(expected, 'not')) return row[field] !== expected.not;
        if (Object.hasOwn(expected, 'equals')) return row[field] === expected.equals;
      }
      return row[field] === expected;
    });
  }

  function createTransaction(draft) {
    const tx = {
      $queryRaw: async () => [],
      $queryRawUnsafe: async () => [],
      importBatch: {
        findUnique: async ({ where, include, select }) => {
          const found = draft.batches.find(({ id }) => id === where.id);
          if (!found) return null;
          if (select) return Object.fromEntries(Object.keys(select).map((field) => [field, found[field]]));
          return {
            ...structuredClone(found),
            ...(include?.rowProgress ? { rowProgress: structuredClone(draft.rowProgress.filter((row) => row.importBatchId === where.id)) } : {}),
            ...(include?.changes ? {
              changes: draft.changeLogs.filter((item) => item.importBatchId === where.id).map((item) => ({
                ...structuredClone(item),
                ...(include.changes.include?.batch ? {
                  batch: structuredClone(draft.batches.find(({ id }) => id === item.importBatchId)),
                } : {}),
                ...(include.changes.include?.rowProgress
                  ? { rowProgress: structuredClone(draft.rowProgress.find(({ id }) => id === item.rowProgressId) || null) }
                  : {}),
              })),
            } : {}),
          };
        },
        update: async ({ where, data }) => Object.assign(draft.batches.find(({ id }) => id === where.id), data),
      },
      importRowProgress: {
        findMany: async ({ where = {} } = {}) => draft.rowProgress.filter((row) => matchesWhere(row, where)).map((row) => structuredClone(row)),
      },
      importChangeLog: {
        findMany: async ({ where = {}, include } = {}) => draft.changeLogs
          .filter((item) => matchesWhere(item, where))
          .map((item) => ({
            ...structuredClone(item),
            ...(include?.batch ? {
              batch: structuredClone(draft.batches.find(({ id }) => id === item.importBatchId)),
            } : {}),
            ...(include?.rowProgress
              ? { rowProgress: structuredClone(draft.rowProgress.find(({ id }) => id === item.rowProgressId) || null) }
              : {}),
          })),
        update: async ({ where, data }) => {
          const found = draft.changeLogs.find(({ id }) => id === where.id);
          Object.assign(found, structuredClone(data));
          return structuredClone(found);
        },
      },
      auditLog: {
        findFirst: async ({ where = {} } = {}) => structuredClone(draft.auditLogs.find((entry) => matchesWhere(entry, where)) || null),
        create: async ({ data }) => {
          draft.auditLogs.push(data);
          return data;
        },
      },
    };
    for (const [tableName, rows] of Object.entries(draft.tables)) {
      tx[tableName] = {
        findMany: async ({ where = {} } = {}) => rows.filter((row) => matchesWhere(row, where)).map((row) => structuredClone(row)),
        findUnique: async ({ where }) => {
          draft.recordFindUniqueCalls.push(tableName);
          return structuredClone(rows.find(({ id }) => id === where.id) || null);
        },
        update: async ({ where, data }) => {
          const row = rows.find(({ id }) => id === where.id);
          Object.assign(row, structuredClone(data));
          return structuredClone(row);
        },
        updateMany: async ({ where, data }) => {
          const matches = rows.filter((row) => matchesWhere(row, where));
          for (const row of matches) Object.assign(row, structuredClone(data));
          return { count: matches.length };
        },
        deleteMany: async ({ where }) => {
          if (failAtDelete === tableName) throw new Error(`Injected failure deleting ${tableName}.`);
          const matches = rows.filter((row) => matchesWhere(row, where));
          draft.tables[tableName] = rows.filter((row) => !matches.includes(row));
          tx[tableName] = createTableDelegate(draft, tableName);
          draft.deletionOrder.push(tableName);
          return { count: matches.length };
        },
      };
    }
    return tx;
  }

  function createTableDelegate(draft, tableName) {
    const rows = draft.tables[tableName];
    return {
      findMany: async ({ where = {} } = {}) => rows.filter((row) => matchesWhere(row, where)).map((row) => structuredClone(row)),
      findUnique: async ({ where }) => structuredClone(rows.find(({ id }) => id === where.id) || null),
      update: async ({ where, data }) => {
        const row = rows.find(({ id }) => id === where.id);
        Object.assign(row, structuredClone(data));
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const matches = rows.filter((row) => matchesWhere(row, where));
        for (const row of matches) Object.assign(row, structuredClone(data));
        return { count: matches.length };
      },
      deleteMany: async ({ where }) => {
        if (failAtDelete === tableName) throw new Error(`Injected failure deleting ${tableName}.`);
        const matches = rows.filter((row) => matchesWhere(row, where));
        draft.tables[tableName] = rows.filter((row) => !matches.includes(row));
        draft.deletionOrder.push(tableName);
        return { count: matches.length };
      },
    };
  }

  const database = {
    $transaction: async (callback, options) => {
      transactionOptions.push(options);
      const draft = structuredClone(state);
      const result = await callback(createTransaction(draft));
      Object.assign(state, draft);
      return result;
    },
  };
  return { database, state, targetBatch, laterBatch, transactionOptions };
}

function makeCreate(type, entity, sequence, batchId = targetId) {
  return change(batchId, sequence, type, entity.id, 'CREATE', {}, entity, `${batchId}-row`);
}

function importRow(table, recordId, extra = {}) {
  return { id: recordId, customerId: null, vehicleId: null, ...extra };
}

test('deletes only target-created customer, vehicle, and service history while retaining import evidence', async () => {
  const customer = record('Customer', 'customer-target');
  const vehicle = record('Vehicle', 'vehicle-target', { customerId: customer.id });
  const visit = record('WorkshopVisit', 'visit-target', { customerId: customer.id, vehicleId: vehicle.id });
  const changes = [
    makeCreate('Customer', customer, 1),
    makeCreate('Vehicle', vehicle, 2),
    makeCreate('WorkshopVisit', visit, 3),
  ];
  const { database, state, targetBatch, transactionOptions } = createDatabase({
    targetChanges: changes,
    targetRecords: { Customer: [customer], Vehicle: [vehicle], WorkshopVisit: [visit] },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.willDelete.length, 3);
  assert.equal(preview.blockers.length, 0);
  assert.ok(preview.dependencies.length > 0);
  assert.ok(preview.dependencies.every(({ disposition, blocked }) => (
    disposition === 'deleted_with_target_import' && blocked === false
  )));
  const result = await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);

  assert.equal(result.status, 'permanently_deleted');
  assert.deepEqual(state.tables.customer, []);
  assert.deepEqual(state.tables.vehicle, []);
  assert.deepEqual(state.tables.workshopVisit, []);
  assert.equal(state.batches.find(({ id }) => id === targetBatch.id).status, 'permanently_deleted');
  assert.equal(state.changeLogs.length, 3);
  assert.ok(state.changeLogs.every(({ rollbackStatus }) => rollbackStatus === 'pending'));
  assert.equal(state.auditLogs.length, 1);
  assert.deepEqual(transactionOptions.at(-1), {
    isolationLevel: 'Serializable',
    timeout: 60_000,
  });
});

test('permanent deletion batches current-record reads for large imports', async () => {
  const visits = Array.from({ length: 501 }, (_, index) => (
    record('WorkshopVisit', `visit-target-${index}`)
  ));
  const changes = visits.map((visit, index) => change(
    targetId,
    index + 1,
    'WorkshopVisit',
    visit.id,
    'CREATE',
    {},
    visit,
    `${targetId}-row-${index}`,
  ));
  const { database, state } = createDatabase({
    targetChanges: changes,
    targetRecords: { WorkshopVisit: visits },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.willDelete.length, 501);
  assert.equal(preview.blockers.length, 0);
  assert.deepEqual(state.recordFindUniqueCalls, []);
});

test('preserves empty-import confirmation behavior and is idempotent without rewriting change logs', async () => {
  const { database, state } = createDatabase();
  const preview = await previewPermanentImportDeletion(targetId, database);
  assert.equal(preview.deletionBlocked, false);
  assert.ok(preview.confirmationToken);

  const result = await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);
  const retry = await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);
  assert.equal(result.status, 'permanently_deleted');
  assert.equal(retry.alreadyDeleted, true);
  assert.equal(state.auditLogs.length, 1);
  assert.deepEqual(state.changeLogs, []);
});

test('allows a verified zero-row import deletion and reports that no business records changed', async () => {
  const { database, state } = createDatabase({ emptyImport: true });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.deletionBlocked, false);
  assert.equal(preview.totalRecordsDeleted, 0);
  assert.equal(preview.existingRecordsRestored, 0);
  assert.equal(preview.existingRecordsRebased, 0);
  assert.ok(preview.confirmationToken);
  const result = await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);

  assert.equal(result.summary.totalRecordsDeleted, 0);
  assert.equal(result.summary.existingRecordsRestored, 0);
  assert.equal(state.batches.find(({ id }) => id === targetId).status, 'permanently_deleted');
  assert.deepEqual(state.tables.customer, []);
});

test('deletes only target-created service history for a pre-existing customer and preserves unrelated history', async () => {
  const targetVisit = record('WorkshopVisit', 'visit-target');
  const existingVisit = record('WorkshopVisit', 'visit-existing', { repairOrderNo: 'RO-EXISTING' });
  const customer = record('Customer', 'customer-existing');
  const vehicle = record('Vehicle', 'vehicle-existing', { customerId: customer.id });
  targetVisit.customerId = customer.id;
  targetVisit.vehicleId = vehicle.id;
  existingVisit.customerId = customer.id;
  existingVisit.vehicleId = vehicle.id;
  const targetVisitChange = makeCreate('WorkshopVisit', targetVisit, 1);
  delete targetVisitChange.after.normalizedRepairOrderNo;
  const { database, state } = createDatabase({
    targetChanges: [targetVisitChange],
    targetRecords: { Customer: [customer], Vehicle: [vehicle], WorkshopVisit: [targetVisit, existingVisit] },
    workflows: {
      freeServiceMilestone: [{
        id: 'milestone-other-vehicle',
        vehicleId: 'vehicle-other',
        physicalVehicleId: 'physical-other',
        completedByRepairOrderNo: targetVisit.repairOrderNo,
      }],
    },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.willDelete.length, 1);
  assert.deepEqual(preview.blockers, []);
  await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);

  assert.deepEqual(state.tables.customer.map(({ id }) => id), [customer.id]);
  assert.deepEqual(state.tables.vehicle.map(({ id }) => id), [vehicle.id]);
  assert.deepEqual(state.tables.workshopVisit.map(({ id }) => id), [existingVisit.id]);
});

test('restores only target-updated vehicle fields and preserves a later independently logged field change', async () => {
  const vehicle = record('Vehicle', 'vehicle-existing', { saleDate: '2020-01-01', model: 'i20' });
  const targetAfter = { ...vehicle, saleDate: '2021-01-01', updatedAt: new Date('2026-01-02T00:00:00.000Z') };
  const targetVisit = record('WorkshopVisit', 'visit-target');
  targetVisit.vehicleId = vehicle.id;
  const update = change(targetId, 2, 'Vehicle', vehicle.id, 'UPDATE', {
    saleDate: vehicle.saleDate,
    updatedAt: vehicle.updatedAt,
  }, {
    saleDate: targetAfter.saleDate,
    updatedAt: targetAfter.updatedAt,
  });
  const laterAfter = { ...targetAfter, model: 'Venue', updatedAt: new Date('2026-02-02T00:00:00.000Z') };
  const laterChange = change(laterId, 1, 'Vehicle', vehicle.id, 'UPDATE', {
    model: targetAfter.model,
    updatedAt: targetAfter.updatedAt,
  }, {
    model: laterAfter.model,
    updatedAt: laterAfter.updatedAt,
  }, `${laterId}-row`);
  const { database, state } = createDatabase({
    targetChanges: [makeCreate('WorkshopVisit', targetVisit, 1), update],
    laterChanges: [laterChange],
    targetRecords: { Vehicle: [laterAfter], WorkshopVisit: [targetVisit] },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.blockers.length, 0);
  assert.equal(preview.willRestore.length, 1);
  assert.deepEqual(preview.willRestore[0].fields, {
    saleDate: { before: '2020-01-01', current: '2021-01-01' },
  });
  await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);

  const restored = state.tables.vehicle[0];
  assert.equal(restored.saleDate.toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal(restored.model, 'Venue');
  assert.equal(restored.updatedAt.toISOString(), '2026-02-02T00:00:00.000Z');
  assert.equal(state.changeLogs.find(({ importBatchId }) => importBatchId === laterId).rollbackStatus, 'pending');
});

test('rebases a later same-field import when deleting an earlier update', async () => {
  const baseAt = new Date('2026-01-01T00:00:00.000Z');
  const targetAt = new Date('2026-01-02T00:00:00.000Z');
  const laterAt = new Date('2026-01-03T00:00:00.000Z');
  const customer = record('Customer', 'customer-rebase', {
    fullName: 'Latest Name',
    updatedAt: laterAt,
  });
  const targetVisit = record('WorkshopVisit', 'visit-target-rebase', {
    customerId: customer.id,
    vehicleId: 'vehicle-existing',
  });
  const laterVisit = record('WorkshopVisit', 'visit-later-rebase', {
    customerId: customer.id,
    vehicleId: 'vehicle-existing',
  });
  const targetUpdate = change(targetId, 2, 'Customer', customer.id, 'UPDATE', {
    fullName: 'Old Name',
    updatedAt: baseAt,
  }, {
    fullName: 'Updated Name',
    updatedAt: targetAt,
  });
  const laterUpdate = change(laterId, 2, 'Customer', customer.id, 'UPDATE', {
    fullName: 'Updated Name',
    updatedAt: targetAt,
  }, {
    fullName: 'Latest Name',
    updatedAt: laterAt,
  }, `${laterId}-row`);
  const { database, state } = createDatabase({
    targetChanges: [makeCreate('WorkshopVisit', targetVisit, 1), targetUpdate],
    laterChanges: [makeCreate('WorkshopVisit', laterVisit, 1, laterId), laterUpdate],
    targetRecords: {
      Customer: [customer],
      WorkshopVisit: [targetVisit, laterVisit],
    },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.blockers.length, 0);
  assert.equal(preview.totalRecordsDeleted, 1);
  assert.equal(preview.existingRecordsRebased, 1);
  assert.equal(preview.recordsPreserved, 1);
  await permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database);

  assert.equal(state.tables.customer[0].fullName, 'Latest Name');
  assert.deepEqual(state.tables.workshopVisit.map(({ id }) => id), [laterVisit.id]);
  const rebasedLaterUpdate = state.changeLogs.find(({ id }) => id === laterUpdate.id);
  assert.equal(rebasedLaterUpdate.before.fullName, 'Old Name');
  assert.equal(new Date(rebasedLaterUpdate.before.updatedAt).toISOString(), baseAt.toISOString());
});

test('blocks rolled-back or permanently-deleted cross-batch logs without independent reversal proof', async () => {
  const states = [
    { batchStatus: 'rolled_back', logStatus: 'rolled_back' },
    { batchStatus: 'permanently_deleted', logStatus: 'permanently_deleted' },
    { batchStatus: 'completed', logStatus: 'rolled_back' },
    { batchStatus: 'rolled_back', logStatus: 'pending' },
  ];

  for (const [index, { batchStatus, logStatus }] of states.entries()) {
    const vehicle = record('Vehicle', `vehicle-existing-${index}`, { saleDate: '2020-01-01', model: 'i20' });
    const targetAfter = {
      saleDate: '2021-01-01',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const targetVisit = record('WorkshopVisit', `visit-target-${index}`, { vehicleId: vehicle.id });
    const laterAfter = {
      ...vehicle,
      saleDate: targetAfter.saleDate,
      model: 'Venue',
      updatedAt: new Date('2026-02-02T00:00:00.000Z'),
    };
    const laterUpdate = {
      ...change(laterId, 1, 'Vehicle', vehicle.id, 'UPDATE', {
        model: vehicle.model,
        updatedAt: targetAfter.updatedAt,
      }, {
        model: laterAfter.model,
        updatedAt: laterAfter.updatedAt,
      }, `${laterId}-row`),
      rollbackStatus: logStatus,
      rolledBackAt: logStatus === 'pending' ? null : fixedDate,
      rollbackError: logStatus === 'pending' ? null : 'Historical reversal status not independently proven.',
    };
    const { database } = createDatabase({
      targetChanges: [
        makeCreate('WorkshopVisit', targetVisit, 1),
        change(targetId, 2, 'Vehicle', vehicle.id, 'UPDATE', {
          saleDate: vehicle.saleDate,
          updatedAt: vehicle.updatedAt,
        }, targetAfter),
      ],
      laterChanges: [laterUpdate],
      laterBatchStatus: batchStatus,
      targetRecords: {
        Vehicle: [laterAfter],
        WorkshopVisit: [targetVisit],
      },
    });

    const preview = await previewPermanentImportDeletion(targetId, database);
    assert.equal(preview.confirmationToken, null, `${batchStatus}/${logStatus} must block`);
    const blocker = preview.blockers.find(({ code }) => code === 'cross-batch-reversal-unverified');
    assert.ok(blocker, `${batchStatus}/${logStatus} must have an explicit cross-batch blocker`);
    assert.equal(blocker.importBatchId, laterId);
    assert.equal(blocker.changeLogId, laterUpdate.id);
    assert.match(blocker.message, /cannot be independently verified/);
  }
});

test('blocks cross-batch evidence with contradictory batch-level rollback metadata', async () => {
  const metadataCases = [
    { batchStatus: 'completed', rollback: { rolledBackAt: fixedDate } },
    { batchStatus: 'completed', rollback: { rollbackError: 'Unverified rollback attempt.' } },
    { batchStatus: 'failed', rollback: { rolledBackAt: fixedDate } },
    { batchStatus: 'failed', rollback: { rollbackError: 'Unverified rollback attempt.' } },
    { batchStatus: 'completed', rollback: { rolledBackAt: fixedDate, rollbackError: 'Unverified rollback attempt.' } },
  ];

  for (const [index, { batchStatus, rollback }] of metadataCases.entries()) {
    const vehicle = record('Vehicle', `vehicle-batch-metadata-${index}`, { saleDate: '2020-01-01', model: 'i20' });
    const targetAfter = { saleDate: '2021-01-01', updatedAt: new Date('2026-01-02T00:00:00.000Z') };
    const targetVisit = record('WorkshopVisit', `visit-batch-metadata-${index}`, { vehicleId: vehicle.id });
    const laterAfter = {
      ...vehicle,
      saleDate: targetAfter.saleDate,
      model: 'Venue',
      updatedAt: new Date('2026-02-02T00:00:00.000Z'),
    };
    const laterUpdate = change(laterId, 1, 'Vehicle', vehicle.id, 'UPDATE', {
      model: vehicle.model,
      updatedAt: targetAfter.updatedAt,
    }, {
      model: laterAfter.model,
      updatedAt: laterAfter.updatedAt,
    }, `${laterId}-row`);
    const { database } = createDatabase({
      targetChanges: [
        makeCreate('WorkshopVisit', targetVisit, 1),
        change(targetId, 2, 'Vehicle', vehicle.id, 'UPDATE', {
          saleDate: vehicle.saleDate,
          updatedAt: vehicle.updatedAt,
        }, targetAfter),
      ],
      laterChanges: [laterUpdate],
      laterBatchStatus: batchStatus,
      laterBatchRollback: rollback,
      targetRecords: { Vehicle: [laterAfter], WorkshopVisit: [targetVisit] },
    });

    const preview = await previewPermanentImportDeletion(targetId, database);
    assert.equal(preview.confirmationToken, null, `${batchStatus} with rollback metadata must block`);
    const blocker = preview.blockers.find(({ code }) => code === 'cross-batch-reversal-unverified');
    assert.ok(blocker, `${batchStatus} with rollback metadata needs a cross-batch blocker`);
    assert.equal(blocker.importBatchId, laterId);
    assert.equal(blocker.changeLogId, laterUpdate.id);
    assert.match(blocker.message, /contradictory batch rollback metadata/);
  }
});

test('blocks target-batch deletion when rollback metadata contradicts pending target logs', async () => {
  const visit = record('WorkshopVisit', 'visit-target-rollback-metadata');
  for (const rollback of [
    { rolledBackAt: fixedDate },
    { rollbackError: 'Unverified rollback attempt.' },
    { rolledBackAt: fixedDate, rollbackError: 'Unverified rollback attempt.' },
  ]) {
    const { database } = createDatabase({
      targetChanges: [makeCreate('WorkshopVisit', visit, 1)],
      targetRecords: { WorkshopVisit: [visit] },
      targetBatchRollback: rollback,
    });
    const preview = await previewPermanentImportDeletion(targetId, database);
    assert.equal(preview.confirmationToken, null);
    const blocker = preview.blockers.find(({ code }) => code === 'target-batch-rollback-metadata-unverified');
    assert.ok(blocker);
    assert.equal(blocker.importBatchId, targetId);
    assert.equal(blocker.changeLogId, `${targetId}-change-1`);
  }
});

test('target CREATE and UPDATE logs with contradictory rollback metadata block deletion plans', async () => {
  const createdVisit = record('WorkshopVisit', 'visit-target-invalid-log');
  const vehicle = record('Vehicle', 'vehicle-target-invalid-update', { saleDate: '2021-01-01' });
  const updatedVehicle = {
    ...vehicle,
    saleDate: '2022-01-01',
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };
  const update = change(targetId, 2, 'Vehicle', vehicle.id, 'UPDATE', {
    saleDate: vehicle.saleDate,
    updatedAt: vehicle.updatedAt,
  }, {
    saleDate: updatedVehicle.saleDate,
    updatedAt: updatedVehicle.updatedAt,
  });

  for (const [targetChanges, targetRecords, invalidSequence] of [
    [[makeCreate('WorkshopVisit', createdVisit, 1)], { WorkshopVisit: [createdVisit] }, 1],
    [
      [makeCreate('WorkshopVisit', createdVisit, 1), update],
      { WorkshopVisit: [createdVisit], Vehicle: [updatedVehicle] },
      2,
    ],
  ]) {
    for (const metadata of [
      { rolledBackAt: fixedDate },
      { rollbackError: 'Unverified rollback attempt.' },
      { rolledBackAt: fixedDate, rollbackError: 'Unverified rollback attempt.' },
    ]) {
      const { database, state } = createDatabase({ targetChanges, targetRecords });
      const targetLog = state.changeLogs.find((item) => (
        item.importBatchId === targetId && item.sequence === invalidSequence
      ));
      Object.assign(targetLog, metadata);
      const preview = await previewPermanentImportDeletion(targetId, database);

      assert.equal(preview.confirmationToken, null);
      const blocker = preview.blockers.find(({ code, changeLogId }) => (
        code === 'invalid-target-change-rollback-metadata' && changeLogId === targetLog.id
      ));
      assert.ok(blocker);
      assert.equal(blocker.importBatchId, targetId);
      assert.match(blocker.message, /rolledBackAt is set|rollbackError is set/);
    }
  }
});

test('confirmation recomputes target-log rollback metadata before mutating records', async () => {
  const visit = record('WorkshopVisit', 'visit-target-confirmation-metadata');
  const { database, state } = createDatabase({
    targetChanges: [makeCreate('WorkshopVisit', visit, 1)],
    targetRecords: { WorkshopVisit: [visit] },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);
  assert.ok(preview.confirmationToken);

  state.changeLogs[0].rollbackError = 'Unverified rollback attempt.';
  await assert.rejects(
    permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database),
    PermanentImportDeletionConflict,
  );
  assert.equal(state.tables.workshopVisit.length, 1);
  assert.equal(state.batches.find(({ id }) => id === targetId).status, 'completed');
});

test('blocks deletion of target-created records referenced by CRM workflows or later imports', async () => {
  const customer = record('Customer', 'customer-target');
  const vehicle = record('Vehicle', 'vehicle-target', { customerId: customer.id });
  const visit = record('WorkshopVisit', 'visit-target', { customerId: customer.id, vehicleId: vehicle.id });
  const workflow = importRow('callLog', 'call-target', { customerId: customer.id, vehicleId: vehicle.id });
  const laterVisit = record('WorkshopVisit', 'visit-later', { customerId: customer.id, vehicleId: vehicle.id });
  const laterChange = makeCreate('WorkshopVisit', laterVisit, 1, laterId);
  const { database } = createDatabase({
    targetChanges: [
      makeCreate('Customer', customer, 1),
      makeCreate('Vehicle', vehicle, 2),
      makeCreate('WorkshopVisit', visit, 3),
    ],
    laterChanges: [laterChange],
    targetRecords: { Customer: [customer], Vehicle: [vehicle], WorkshopVisit: [visit, laterVisit] },
    workflows: { callLog: [workflow] },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.confirmationToken, null);
  assert.ok(preview.blockers.some(({ code }) => code === 'crm-workflow-reference'));
  assert.ok(preview.blockers.some(({ code }) => code === 'later-import-dependency'));
});

test('blocks every schema-backed customer, vehicle, VIN, and repair-order dependency', async () => {
  const cases = [
    { type: 'WorkshopVisit', table: 'WorkshopVisit', key: 'WorkshopVisit', fields: { customerId: 'customer-target', vehicleId: 'vehicle-target' } },
    { type: 'Allocation', table: 'Allocation', key: 'Allocation', fields: { vehicleId: 'vehicle-target' } },
    { type: 'CallLog', table: 'callLog', key: 'callLog', fields: { customerId: 'customer-target', vehicleId: 'vehicle-target' } },
    { type: 'FollowUp', table: 'followUp', key: 'followUp', fields: { customerId: 'customer-target', vehicleId: 'vehicle-target' } },
    { type: 'Appointment', table: 'appointment', key: 'appointment', fields: { customerId: 'customer-target', vehicleId: 'vehicle-target' } },
    { type: 'VehicleOwnershipHistory', table: 'vehicleOwnershipHistory', key: 'vehicleOwnershipHistory', fields: { vehicleId: 'vehicle-target' } },
    { type: 'MonthlyCustomerDataEntry', table: 'monthlyCustomerDataEntry', key: 'monthlyCustomerDataEntry', fields: { customerId: 'customer-target', vehicleId: 'vehicle-target' } },
    { type: 'FreeServiceMilestone', table: 'freeServiceMilestone', key: 'freeServiceMilestone', fields: { vehicleId: 'vehicle-target' } },
    { type: 'MasterCallList', table: 'MasterCallList', key: 'MasterCallList', fields: { vin: 'vehicle-target-vin', ccmId: 'ccm-test' } },
    { type: 'VINConflictReview', table: 'VINConflictReview', key: 'VINConflictReview', fields: { vin: 'vehicle-target-vin', sourceCcmId: 'ccm-test' } },
  ];

  for (const [index, item] of cases.entries()) {
    const customer = record('Customer', 'customer-target');
    const vehicle = record('Vehicle', 'vehicle-target', { customerId: customer.id });
    const targetVisit = record('WorkshopVisit', 'visit-target', { customerId: customer.id, vehicleId: vehicle.id });
    const workflow = { id: `workflow-${index}`, ...item.fields };
    const targetRecords = {
      Customer: [customer],
      Vehicle: [vehicle],
      WorkshopVisit: [targetVisit],
      ...(item.key === 'WorkshopVisit' ? { WorkshopVisit: [targetVisit, workflow] } : {}),
      ...(item.key === 'Allocation' ? { Allocation: [workflow] } : {}),
      ...(item.key === 'MasterCallList' ? { MasterCallList: [workflow] } : {}),
      ...(item.key === 'VINConflictReview' ? { VINConflictReview: [workflow] } : {}),
    };
    const workflows = ['callLog', 'followUp', 'appointment', 'vehicleOwnershipHistory', 'monthlyCustomerDataEntry', 'freeServiceMilestone']
      .includes(item.key)
      ? { [item.key]: [workflow] }
      : {};
    const { database } = createDatabase({
      targetChanges: [
        makeCreate('Customer', customer, 1),
        makeCreate('Vehicle', vehicle, 2),
        makeCreate('WorkshopVisit', targetVisit, 3),
      ],
      targetRecords,
      workflows,
    });
    const preview = await previewPermanentImportDeletion(targetId, database);

    assert.ok(
      preview.blockers.some(({ relatedEntityType, relatedEntityId }) => relatedEntityType === item.type && relatedEntityId === workflow.id),
      `${item.type} reference must block deletion`,
    );
    assert.equal(preview.confirmationToken, null);
  }
});

test('blocks missing target-created entities and incomplete or unsupported evidence', async () => {
  const customer = record('Customer', 'customer-missing');
  const missingDb = createDatabase({ targetChanges: [makeCreate('Customer', customer, 1)] });
  const missingPreview = await previewPermanentImportDeletion(targetId, missingDb.database);
  assert.ok(missingPreview.blockers.some(({ code }) => code === 'target-entity-missing'));

  const invalid = makeCreate('Vehicle', record('Vehicle', 'vehicle-invalid'), 1);
  invalid.operation = 'DELETE';
  const invalidDb = createDatabase({ targetChanges: [invalid] });
  const invalidPreview = await previewPermanentImportDeletion(targetId, invalidDb.database);
  assert.ok(invalidPreview.blockers.some(({ code }) => code === 'invalid-change-log'));
});

test('blocks unexpected current-state changes and stale confirmation tokens', async () => {
  const customer = record('Customer', 'customer-target', { fullName: 'Imported name' });
  const { database, state } = createDatabase({
    targetChanges: [makeCreate('Customer', customer, 1)],
    targetRecords: { Customer: [{ ...customer, fullName: 'Manually edited name' }] },
  });
  const preview = await previewPermanentImportDeletion(targetId, database);
  assert.ok(preview.blockers.some(({ code }) => code === 'snapshot-mismatch'));

  const safe = createDatabase({
    targetChanges: [makeCreate('Customer', customer, 1)],
    targetRecords: { Customer: [customer] },
  });
  const safePreview = await previewPermanentImportDeletion(targetId, safe.database);
  safe.state.batches.find(({ id }) => id === targetId).fileName = 'changed-after-preview.csv';
  await assert.rejects(
    permanentlyDeleteImportBatch(targetId, 'admin-1', safePreview.confirmationToken, safe.database),
    (error) => error instanceof PermanentImportDeletionConflict && /preview/i.test(error.message),
  );
  assert.equal(safe.state.tables.customer.length, 1);
  assert.equal(state.tables.customer.length, 1);
});

test('blocks a batch with incomplete row-progress mutation evidence', async () => {
  const { database, state } = createDatabase();
  state.rowProgress[0].mutationState = 'pending';
  const preview = await previewPermanentImportDeletion(targetId, database);

  assert.equal(preview.confirmationToken, null);
  assert.ok(preview.blockers.some(({ code }) => code === 'incomplete-import-evidence'));
});

test('rolls back all business mutations when deletion fails mid-transaction', async () => {
  const customer = record('Customer', 'customer-target');
  const vehicle = record('Vehicle', 'vehicle-target', { customerId: customer.id });
  const visit = record('WorkshopVisit', 'visit-target', { customerId: customer.id, vehicleId: vehicle.id });
  const { database, state } = createDatabase({
    targetChanges: [
      makeCreate('Customer', customer, 1),
      makeCreate('Vehicle', vehicle, 2),
      makeCreate('WorkshopVisit', visit, 3),
    ],
    targetRecords: { Customer: [customer], Vehicle: [vehicle], WorkshopVisit: [visit] },
    failAtDelete: 'vehicle',
  });
  const preview = await previewPermanentImportDeletion(targetId, database);
  const initial = structuredClone(state);

  await assert.rejects(permanentlyDeleteImportBatch(targetId, 'admin-1', preview.confirmationToken, database), /Injected failure/);
  assert.deepEqual(state.tables, initial.tables);
  assert.equal(state.batches.find(({ id }) => id === targetId).status, 'completed');
  assert.equal(state.auditLogs.length, 0);
});
