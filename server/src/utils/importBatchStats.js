import { normalizeRepairOrderNo } from './repairOrderIdentity.js';

const rowOutcomeFields = {
  created: 'createdRows',
  monthly_added: 'createdRows',
  appended: 'appendedRows',
  skipped: 'skippedRows',
  rejected: 'rejectedRows',
  flagged: 'flaggedRows',
};

const entityCountFields = {
  Customer: 'affectedCustomers',
  Vehicle: 'affectedVehicles',
  WorkshopVisit: 'affectedRepairOrders',
  MasterCallList: 'affectedCallListEntries',
  Allocation: 'affectedAllocations',
  MonthlyCustomerDataEntry: 'affectedMonthlyEntries',
};

const createSnapshotFields = {
  Customer: ['id', 'customerCode', 'fullName', 'mobileNumber', 'alternatePhone', 'email', 'ccmId', 'createdAt', 'updatedAt'],
  Vehicle: ['id', 'vin', 'registrationNumber', 'make', 'model', 'variant', 'year', 'saleDate', 'status', 'customerId', 'ccmId', 'createdAt', 'updatedAt'],
  WorkshopVisit: ['id', 'repairOrderNo', 'customerId', 'vehicleId', 'ccmId', 'totalLaborCost', 'totalPartsCost', 'totalAmount', 'visitDate', 'closingDate', 'gpDate', 'importedDetails', 'createdAt', 'updatedAt'],
  MasterCallList: ['id', 'customerName', 'mobileNumber', 'vin', 'registrationNumber', 'ccmId', 'ownerUserId', 'status', 'createdAt', 'updatedAt'],
  VINConflictReview: ['id', 'vin', 'sourceCcmId', 'targetCcmId', 'reason', 'status', 'reviewNotes', 'createdAt', 'updatedAt'],
  MonthlyCustomerDataEntry: ['id', 'datasetId', 'customerId', 'vehicleId', 'createdById', 'dedupeKey', 'customerName', 'mobileNumber', 'email', 'vin', 'registrationNumber', 'make', 'model', 'vehicleYear', 'serviceType', 'lastVisitDate', 'nextServiceDueDate', 'notes', 'source', 'createdAt'],
};

const createSnapshotOptionalFields = {
  MasterCallList: ['assignmentNeedsReview', 'vehicleId'],
  Vehicle: ['physicalVehicleId'],
  WorkshopVisit: ['normalizedRepairOrderNo', 'physicalVehicleId'],
  MonthlyCustomerDataEntry: ['createdByIdSnapshot', 'createdByNameSnapshot', 'createdByUsernameSnapshot'],
};

const updateSnapshotFields = {
  Customer: new Set(['customerCode', 'fullName', 'mobileNumber', 'alternatePhone', 'email', 'ccmId', 'updatedAt']),
  Vehicle: new Set(['vin', 'registrationNumber', 'make', 'model', 'variant', 'year', 'saleDate', 'status', 'customerId', 'ccmId', 'updatedAt']),
  WorkshopVisit: new Set(['repairOrderNo', 'customerId', 'vehicleId', 'ccmId', 'totalLaborCost', 'totalPartsCost', 'totalAmount', 'visitDate', 'closingDate', 'gpDate', 'importedDetails', 'updatedAt']),
  MasterCallList: new Set(['customerName', 'mobileNumber', 'vin', 'registrationNumber', 'ccmId', 'vehicleId', 'ownerUserId', 'assignmentNeedsReview', 'status', 'updatedAt']),
  Allocation: new Set(['vehicleId', 'creId', 'ccmId', 'serviceType', 'category', 'status', 'notes', 'updatedAt']),
};

const snapshotDateFields = {
  Customer: { required: ['createdAt', 'updatedAt'], nullable: [] },
  Vehicle: { required: ['createdAt', 'updatedAt'], nullable: ['saleDate'] },
  WorkshopVisit: { required: ['createdAt', 'updatedAt'], nullable: ['visitDate', 'closingDate', 'gpDate'] },
  MasterCallList: { required: ['createdAt', 'updatedAt'], nullable: [] },
  VINConflictReview: { required: ['createdAt', 'updatedAt'], nullable: [] },
  MonthlyCustomerDataEntry: { required: ['createdAt'], nullable: ['lastVisitDate', 'nextServiceDueDate'] },
};

const updateDateFields = {
  Customer: ['updatedAt'],
  Vehicle: ['saleDate', 'updatedAt'],
  WorkshopVisit: ['visitDate', 'closingDate', 'gpDate', 'updatedAt'],
  MasterCallList: ['updatedAt'],
  Allocation: ['updatedAt'],
};

const supportedChangeEntities = new Set([...Object.keys(entityCountFields), 'VINConflictReview']);

function emptyStats() {
  return {
    processedRows: 0,
    createdRows: 0,
    appendedRows: 0,
    skippedRows: 0,
    rejectedRows: 0,
    flaggedRows: 0,
    affectedCustomers: 0,
    affectedVehicles: 0,
    affectedRepairOrders: 0,
    affectedCallListEntries: 0,
    affectedAllocations: 0,
    affectedMonthlyEntries: 0,
  };
}

export async function collectImportBatchStatsForIds(transaction, importBatchIds) {
  if (!importBatchIds.length) return new Map();
  const [rows, changedEntities, progress] = await Promise.all([
    transaction.importRowProgress.groupBy({
      by: ['importBatchId', 'status', 'outcome'],
      where: { importBatchId: { in: importBatchIds } },
      _count: { _all: true },
    }),
    transaction.importChangeLog.groupBy({
      by: ['importBatchId', 'entityType', 'entityId'],
      where: { importBatchId: { in: importBatchIds } },
    }),
    transaction.importRowProgress.groupBy({
      by: ['importBatchId', 'status'],
      where: { importBatchId: { in: importBatchIds }, status: 'completed' },
      _count: { _all: true },
    }),
  ]);
  const statsByBatch = new Map(importBatchIds.map((id) => [id, emptyStats()]));
  for (const row of rows) {
    const counts = statsByBatch.get(row.importBatchId);
    const field = rowOutcomeFields[row.outcome];
    if (counts && row.status === 'completed' && field) counts[field] += row._count._all;
  }
  for (const row of progress) {
    const counts = statsByBatch.get(row.importBatchId);
    if (counts) counts.processedRows += row._count._all;
  }
  for (const entity of changedEntities) {
    const counts = statsByBatch.get(entity.importBatchId);
    const field = entityCountFields[entity.entityType];
    if (counts && field) counts[field] += 1;
  }
  return statsByBatch;
}

export async function collectImportBatchStats(transaction, importBatchId) {
  return (await collectImportBatchStatsForIds(transaction, [importBatchId])).get(importBatchId);
}

export function importProgressIsComplete(batch, completedRows) {
  return completedRows === batch.totalRows && batch.totalRows > 0;
}

export function legacyImportHistoryProgress(batch) {
  const completed = batch.status === 'completed';
  return {
    processedRows: completed ? batch.totalRows : null,
    statsComplete: false,
    rowOutcomesProvenance: completed ? 'legacy-stored-unverified' : 'unknown',
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function stableSnapshotValue(value) {
  if (Array.isArray(value)) return value.map(stableSnapshotValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      stableSnapshotValue(value[key]),
    ]));
  }
  return value;
}

export function importSnapshotValuesMatch(left, right) {
  return JSON.stringify(stableSnapshotValue(left)) === JSON.stringify(stableSnapshotValue(right));
}

function createSnapshotDatesAreComplete(entityType, snapshot) {
  const dateFields = snapshotDateFields[entityType];
  if (!dateFields) return false;
  return dateFields.required.every((field) => isValidTimestamp(snapshot[field]))
    && dateFields.nullable.every((field) => snapshot[field] === null || isValidTimestamp(snapshot[field]));
}

export function importChangeLogIsComplete(change) {
  if (!change.entityId || !supportedChangeEntities.has(change.entityType) || !isRecord(change.after)) return false;
  if (change.operation === 'CREATE') {
    const required = createSnapshotFields[change.entityType];
    if (!required) return false;
    const fields = Object.keys(change.after).sort();
    const optional = createSnapshotOptionalFields[change.entityType] || [];
    const requiredFields = [...required].sort();
    const allowedFields = new Set([...required, ...optional]);
    const hasExpectedFields = requiredFields.every((field) => fields.includes(field))
      && fields.every((field) => allowedFields.has(field));
    const normalizedRepairOrderIsValid = change.entityType !== 'WorkshopVisit'
      || !Object.hasOwn(change.after, 'normalizedRepairOrderNo')
      || change.after.normalizedRepairOrderNo === normalizeRepairOrderNo(change.after.repairOrderNo);
    return isRecord(change.before)
      && Object.keys(change.before).length === 0
      && change.after.id === change.entityId
      && hasExpectedFields
      && normalizedRepairOrderIsValid
      && createSnapshotDatesAreComplete(change.entityType, change.after);
  }
  if (change.operation !== 'UPDATE' || !isRecord(change.before)) return false;
  const permittedFields = updateSnapshotFields[change.entityType];
  if (!permittedFields) return false;
  const beforeFields = Object.keys(change.before).sort();
  const afterFields = Object.keys(change.after).sort();
  const dateFields = updateDateFields[change.entityType] || [];
  return beforeFields.length > 0
    && beforeFields.includes('updatedAt')
    && beforeFields.length === afterFields.length
    && beforeFields.every((field, index) => field === afterFields[index] && permittedFields.has(field))
    && isValidTimestamp(change.before.updatedAt)
    && isValidTimestamp(change.after.updatedAt)
    && beforeFields.some((field) => field !== 'updatedAt'
      && !importSnapshotValuesMatch(change.before[field], change.after[field]))
    && dateFields.filter((field) => beforeFields.includes(field)).every((field) => (
      change.before[field] === null || isValidTimestamp(change.before[field])
    ) && (
      change.after[field] === null || isValidTimestamp(change.after[field])
    ));
}

export function importRowMutationEvidenceIsComplete(outcome, changes, importType = 'repair_order') {
  if (!Array.isArray(changes) || !changes.every(importChangeLogIsComplete)) return false;
  if (importType === 'monthly_customer_data') {
    if (outcome === 'monthly_added') {
      return changes.filter(({ entityType, operation }) => (
        entityType === 'MonthlyCustomerDataEntry' && operation === 'CREATE'
      )).length === 1;
    }
    return ['skipped', 'rejected'].includes(outcome) && changes.length === 0;
  }
  if (outcome === 'created' || outcome === 'appended') {
    return changes.filter(({ entityType, operation }) => entityType === 'WorkshopVisit' && operation === 'CREATE').length === 1;
  }
  if (outcome === 'flagged') {
    return changes.length === 1
      && changes[0].entityType === 'VINConflictReview'
      && changes[0].operation === 'CREATE';
  }
  return ['skipped', 'rejected'].includes(outcome) && changes.length === 0;
}

export function importBatchMutationEvidenceIsComplete(batch) {
  if (!Array.isArray(batch.rowProgress) || !Array.isArray(batch.changes)) return false;
  const { rowProgress, changes } = batch;
  if (batch.totalRows === 0 && rowProgress.length === 0 && changes.length === 0) {
    return batch.allocationEvidenceState === 'not_started'
      && batch.allocationChangeCount === 0
      && ['affectedCustomers', 'affectedVehicles', 'affectedRepairOrders', 'affectedCallListEntries', 'affectedAllocations', 'affectedMonthlyEntries']
        .every((field) => (batch[field] || 0) === 0);
  }
  if (rowProgress.length !== batch.totalRows || batch.totalRows < 1
    || new Set(rowProgress.map(({ rowNumber }) => rowNumber)).size !== batch.totalRows
    || new Set(rowProgress.map(({ id }) => id)).size !== batch.totalRows
    || rowProgress.some(({ id, importBatchId, status }) => !id
      || importBatchId !== batch.id
      || status !== 'completed')
  ) return false;

  const sequences = changes.map(({ sequence }) => sequence);
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)
    || new Set(sequences).size !== sequences.length) return false;

  const progressById = new Map(rowProgress.map((row) => [row.id, row]));
  const changesByRowId = new Map(rowProgress.map(({ id }) => [id, []]));
  const batchAllocationChanges = [];
  for (const change of changes) {
    if (change.importBatchId !== batch.id) return false;
    if (change.evidenceScope === 'row') {
      if (!change.rowProgressId || !progressById.has(change.rowProgressId)
        || change.entityType === 'Allocation') return false;
      changesByRowId.get(change.rowProgressId).push(change);
    } else if (change.evidenceScope === 'batch') {
      if (change.rowProgressId !== null
        || !['MasterCallList', 'Allocation'].includes(change.entityType)
        || change.operation !== 'UPDATE'
        || !importChangeLogIsComplete(change)) return false;
      const expectedFields = change.entityType === 'MasterCallList'
        ? ['ownerUserId', 'updatedAt']
        : ['creId', 'updatedAt'];
      const beforeFields = Object.keys(change.before || {}).sort();
      const afterFields = Object.keys(change.after || {}).sort();
      if (beforeFields.join('|') !== expectedFields.slice().sort().join('|')
        || afterFields.join('|') !== expectedFields.slice().sort().join('|')) return false;
      batchAllocationChanges.push(change);
    } else {
      return false;
    }
  }
  const rowsComplete = rowProgress.every((row) => {
    const rowChanges = changesByRowId.get(row.id);
    return row.mutationState === 'complete'
      && row.loggedChangeCount === rowChanges.length
      && importRowMutationEvidenceIsComplete(row.outcome, rowChanges, batch.importType);
  });
  if (!rowsComplete) return false;
  if (batch.allocationEvidenceState === 'not_started') {
    return batch.allocationChangeCount === 0 && batchAllocationChanges.length === 0;
  }
  return batch.allocationEvidenceState === 'complete'
    && batch.allocationChangeCount === batchAllocationChanges.length
    && batchAllocationChanges.every(importChangeLogIsComplete);
}

export async function importRollbackCompleteness(transaction, batchId, totalRows) {
  const [progress, changes, batch] = await Promise.all([
    transaction.importRowProgress.findMany({
      where: { importBatchId: batchId },
      select: {
        id: true,
        importBatchId: true,
        rowNumber: true,
        status: true,
        outcome: true,
        mutationState: true,
        loggedChangeCount: true,
      },
    }),
    transaction.importChangeLog.findMany({
      where: { importBatchId: batchId },
    }),
    transaction.importBatch.findUnique({
      where: { id: batchId },
      select: {
        importType: true,
        allocationEvidenceState: true,
        allocationChangeCount: true,
        affectedCustomers: true,
        affectedVehicles: true,
        affectedRepairOrders: true,
        affectedCallListEntries: true,
        affectedAllocations: true,
        affectedMonthlyEntries: true,
      },
    }),
  ]);
  return importBatchMutationEvidenceIsComplete({
    id: batchId,
    totalRows,
    rowProgress: progress,
    changes,
    ...batch,
  });
}
