import { prisma } from '../config/prisma.js';
import { lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { importChangeLogIsComplete, importRollbackCompleteness } from '../utils/importBatchStats.js';
import { normalizeRepairOrderNo } from '../utils/repairOrderIdentity.js';
import { recordCreAssignmentEvent } from '../utils/creAssignmentHistory.js';

const entityDelegates = {
  Customer: 'customer',
  Vehicle: 'vehicle',
  WorkshopVisit: 'workshopVisit',
  MasterCallList: 'masterCallList',
  Allocation: 'allocation',
  VINConflictReview: 'vINConflictReview',
  MonthlyCustomerDataEntry: 'monthlyCustomerDataEntry',
};

const entityLabels = {
  Customer: 'customer',
  Vehicle: 'vehicle',
  WorkshopVisit: 'repair order',
  MasterCallList: 'Master Call List entry',
  Allocation: 'CRE allocation',
  VINConflictReview: 'VIN conflict review',
  MonthlyCustomerDataEntry: 'monthly customer-data entry',
};

const entityTables = {
  Customer: 'customers',
  Vehicle: 'vehicles',
  WorkshopVisit: 'workshop_visits',
  MasterCallList: 'master_call_lists',
  Allocation: 'allocations',
  VINConflictReview: 'vin_conflict_reviews',
  MonthlyCustomerDataEntry: 'monthly_customer_data_entries',
};

const dateFields = {
  Customer: ['updatedAt'],
  Vehicle: ['saleDate', 'updatedAt'],
  WorkshopVisit: ['visitDate', 'closingDate', 'gpDate', 'updatedAt'],
  MasterCallList: ['updatedAt'],
  Allocation: ['updatedAt'],
};

export class ImportRollbackConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportRollbackConflict';
  }
}

function comparable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return comparable(value.toJSON());
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, comparable(value[key])]));
  }
  return value;
}

function snapshotMatches(record, expected, requireFullRecord, entityType) {
  const legacyNormalizedRepairOrder = entityType === 'WorkshopVisit'
    && !Object.hasOwn(expected || {}, 'normalizedRepairOrderNo')
    && Object.hasOwn(record || {}, 'normalizedRepairOrderNo');
  const legacyAssignmentReviewFlag = entityType === 'MasterCallList'
    && !Object.hasOwn(expected || {}, 'assignmentNeedsReview')
    && record?.assignmentNeedsReview === false;
  if (legacyNormalizedRepairOrder
    && record.normalizedRepairOrderNo !== normalizeRepairOrderNo(expected.repairOrderNo)) return false;
  if (requireFullRecord) {
    const expectedFields = Object.keys(expected || {}).sort();
    const actualFields = Object.keys(record || {})
      .filter((field) => !((legacyNormalizedRepairOrder && field === 'normalizedRepairOrderNo')
        || (legacyAssignmentReviewFlag && field === 'assignmentNeedsReview')))
      .sort();
    if (expectedFields.length !== actualFields.length
      || expectedFields.some((field, index) => field !== actualFields[index])) return false;
  }
  return Object.entries(expected || {}).every(([field, value]) => (
    JSON.stringify(comparable(record[field])) === JSON.stringify(comparable(value))
  ));
}

async function findEntity(transaction, entityType, entityId) {
  const delegateName = entityDelegates[entityType];
  if (!delegateName) throw new ImportRollbackConflict(`Unsupported recorded entity type: ${entityType}.`);
  const record = await transaction[delegateName].findUnique({ where: { id: entityId } });
  if (!record) throw new ImportRollbackConflict(`The recorded ${entityLabels[entityType]} no longer exists.`);
  return { delegate: transaction[delegateName], record };
}

async function ensureNoReferences(transaction, change) {
  if (change.entityType === 'Customer') {
    const [vehicles, visits, calls, followUps, appointments, monthlyEntries] = await Promise.all([
      transaction.vehicle.count({ where: { customerId: change.entityId } }),
      transaction.workshopVisit.count({ where: { customerId: change.entityId } }),
      transaction.callLog.count({ where: { customerId: change.entityId } }),
      transaction.followUp.count({ where: { customerId: change.entityId } }),
      transaction.appointment.count({ where: { customerId: change.entityId } }),
      transaction.monthlyCustomerDataEntry.count({ where: { customerId: change.entityId } }),
    ]);
    if (vehicles + visits + calls + followUps + appointments + monthlyEntries) {
      throw new ImportRollbackConflict('The imported customer has later customer, vehicle, service, call, appointment, follow-up, or monthly-data dependencies. Remove or reassign those records before retrying rollback.');
    }
  } else if (change.entityType === 'Vehicle') {
    const [visits, calls, followUps, appointments, ownership, allocations, callList, monthlyEntries, milestones] = await Promise.all([
      transaction.workshopVisit.count({ where: { vehicleId: change.entityId } }),
      transaction.callLog.count({ where: { vehicleId: change.entityId } }),
      transaction.followUp.count({ where: { vehicleId: change.entityId } }),
      transaction.appointment.count({ where: { vehicleId: change.entityId } }),
      transaction.vehicleOwnershipHistory.count({ where: { vehicleId: change.entityId } }),
      transaction.allocation.count({ where: { vehicleId: change.entityId } }),
      transaction.masterCallList.count({
        where: {
          ccmId: change.after?.ccmId,
          vin: change.after?.vin,
        },
      }),
      transaction.monthlyCustomerDataEntry.count({ where: { vehicleId: change.entityId } }),
      transaction.freeServiceMilestone.count({ where: { vehicleId: change.entityId } }),
    ]);
    if (visits + calls + followUps + appointments + ownership + allocations + callList + monthlyEntries + milestones) {
      throw new ImportRollbackConflict('The imported vehicle has later service, allocation, call-list, call, appointment, ownership, or monthly-data dependencies. Remove or reassign those records before retrying rollback.');
    }
  } else if (change.entityType === 'WorkshopVisit') {
    const visit = await transaction.workshopVisit.findUnique({
      where: { id: change.entityId },
      select: { physicalVehicleId: true },
    });
    const milestones = await transaction.freeServiceMilestone.findMany({
      where: { physicalVehicleId: visit?.physicalVehicleId || change.after?.physicalVehicleId },
      select: { id: true, completedByWorkshopVisitId: true, completedByRepairOrderNo: true },
    });
    const referenced = milestones.some((milestone) => (
      milestone.completedByWorkshopVisitId === change.entityId
      || (milestone.completedByWorkshopVisitId == null
        && normalizeRepairOrderNo(milestone.completedByRepairOrderNo)
          === normalizeRepairOrderNo(change.after?.repairOrderNo))
    ));
    if (referenced) {
      throw new ImportRollbackConflict('The repair order is referenced by a free-service milestone. Resolve the milestone reference before retrying rollback.');
    }
  }
}

async function recordRollbackAssignmentEvent(transaction, entityType, record, previousCreId, newCreId, actorUserId) {
  if (previousCreId === newCreId || !['MasterCallList', 'Allocation'].includes(entityType)) return;
  const vehicleId = entityType === 'Allocation'
    ? record.vehicleId
    : record.vehicleId || (await transaction.vehicle.findFirst({
      where: { vin: record.vin, ccmId: record.ccmId },
      select: { id: true },
    }))?.id;
  if (!vehicleId) {
    throw new ImportRollbackConflict('The assignment history could not be recorded because its vehicle no longer exists.');
  }
  await recordCreAssignmentEvent(transaction, {
    vehicleId,
    allocationId: entityType === 'Allocation' ? record.id : null,
    masterCallListId: entityType === 'MasterCallList' ? record.id : null,
    ccmId: record.ccmId,
    previousCreId,
    newCreId,
    actorUserId,
    eventType: 'IMPORT_ROLLBACK',
  });
}

async function reverseChange(transaction, change, actorUserId) {
  if (change.rollbackStatus !== 'pending'
    || change.rolledBackAt != null
    || change.rollbackError != null
    || !importChangeLogIsComplete(change)) {
    throw new ImportRollbackConflict(`Change ${change.id} is invalidated or incomplete and cannot be reversed.`);
  }
  const { delegate, record } = await findEntity(transaction, change.entityType, change.entityId);
  if (!snapshotMatches(record, change.after, change.operation === 'CREATE', change.entityType)) {
    throw new ImportRollbackConflict(`The ${entityLabels[change.entityType]} has changed since this import. Its later changes were preserved; resolve the conflict before retrying rollback.`);
  }

  if (change.operation === 'CREATE') {
    await ensureNoReferences(transaction, change);
    await recordRollbackAssignmentEvent(
      transaction,
      change.entityType,
      record,
      record.creId ?? record.ownerUserId ?? null,
      null,
      actorUserId,
    );
    await delegate.delete({ where: { id: change.entityId } });
    return;
  }
  if (change.operation !== 'UPDATE') {
    throw new ImportRollbackConflict(`Unsupported recorded operation: ${change.operation}.`);
  }

  const before = change.before || {};
  const after = change.after || {};
  if (Object.keys(before).length !== Object.keys(after).length
    || Object.keys(before).some((field) => !Object.hasOwn(after, field))) {
    throw new ImportRollbackConflict('The recorded change is incomplete and cannot be reversed safely.');
  }
  const dateFieldSet = new Set(dateFields[change.entityType] || []);
  const restoredValues = Object.fromEntries(Object.entries(before).map(([field, value]) => [
    field,
    dateFieldSet.has(field) && value !== null ? new Date(value) : value,
  ]));
  const assignmentField = change.entityType === 'Allocation' ? 'creId'
    : change.entityType === 'MasterCallList' ? 'ownerUserId' : null;
  if (assignmentField && Object.hasOwn(restoredValues, assignmentField)) {
    await recordRollbackAssignmentEvent(
      transaction,
      change.entityType,
      record,
      record[assignmentField] ?? null,
      restoredValues[assignmentField] ?? null,
      actorUserId,
    );
  }
  await delegate.update({
    where: { id: change.entityId },
    data: restoredValues,
  });
}

function validateRollbackEvidence(batch) {
  if (!['completed', 'failed'].includes(batch.status)) {
    throw new ImportRollbackConflict('Only completed or failed imports can be rolled back.');
  }
  if (batch.rolledBackAt != null || batch.rollbackError != null) {
    throw new ImportRollbackConflict(`Import ${batch.id} has batch-level rollback metadata and cannot be safely reversed.`);
  }
  if (!batch.rollbackSupported) {
    throw new ImportRollbackConflict('This historical import has no verified change snapshots and cannot be safely rolled back.');
  }
  for (const change of batch.changes) {
    if (change.importBatchId !== batch.id
      || change.rollbackStatus !== 'pending'
      || change.rolledBackAt != null
      || change.rollbackError != null
      || !importChangeLogIsComplete(change)) {
      throw new ImportRollbackConflict(`Change ${change.id || '(unknown)'} in import ${batch.id} is invalidated, inconsistent, or incomplete and cannot be safely reversed.`);
    }
  }
}

async function validateNoCrossBatchChanges(transaction, batch) {
  const entities = [...new Map(batch.changes.map(({ entityType, entityId }) => [
    `${entityType}:${entityId}`,
    { entityType, entityId },
  ])).values()];
  if (!entities.length) return;
  const changes = await transaction.importChangeLog.findMany({
    where: { OR: entities.map(({ entityType, entityId }) => ({ entityType, entityId })) },
    select: { id: true, importBatchId: true, entityType: true, entityId: true },
  });
  const crossBatchChange = changes.find(({ importBatchId }) => importBatchId !== batch.id);
  if (crossBatchChange) {
    throw new ImportRollbackConflict(
      `Import ${batch.id} cannot be rolled back because change ${crossBatchChange.id} in import ${crossBatchChange.importBatchId} also references ${crossBatchChange.entityType} ${crossBatchChange.entityId}.`,
    );
  }
}

async function lockRollbackRecords(transaction, changes) {
  const records = [...new Map(changes.map(({ entityType, entityId }) => [
    `${entityType}:${entityId}`,
    { entityType, entityId },
  ])).values()].sort((left, right) => (
    `${entityTables[left.entityType]}:${left.entityId}`.localeCompare(`${entityTables[right.entityType]}:${right.entityId}`)
  ));
  for (const { entityType, entityId } of records) {
    const table = entityTables[entityType];
    if (!table) throw new ImportRollbackConflict(`Unsupported recorded entity type: ${entityType}.`);
    await transaction.$queryRawUnsafe(
      `SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`,
      entityId,
    );
  }
}

async function validateCurrentRollbackState(transaction, changes) {
  const simulatedRecords = new Map();
  for (const change of changes) {
    const key = `${change.entityType}:${change.entityId}`;
    if (!simulatedRecords.has(key)) {
      const { record } = await findEntity(transaction, change.entityType, change.entityId);
      simulatedRecords.set(key, { ...record });
    }
    const current = simulatedRecords.get(key);
    if (!snapshotMatches(current, change.after, change.operation === 'CREATE', change.entityType)) {
      throw new ImportRollbackConflict(`The ${entityLabels[change.entityType]} has changed since this import. Its later changes were preserved; resolve the conflict before retrying rollback.`);
    }
    if (change.operation === 'CREATE') {
      simulatedRecords.set(key, null);
    } else {
      simulatedRecords.set(key, {
        ...current,
        ...Object.fromEntries(Object.entries(change.before).map(([field, value]) => [
          field,
          (dateFields[change.entityType] || []).includes(field) && value !== null ? new Date(value) : value,
        ])),
      });
    }
  }
}

export async function rollbackImportBatch(importBatchId, adminId, database = prisma) {
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "import_batches" WHERE "id" = ${importBatchId} FOR UPDATE`;
    let batch = await transaction.importBatch.findUnique({
      where: { id: importBatchId },
      include: { changes: { orderBy: { sequence: 'desc' } } },
    });
    if (!batch) throw new ImportRollbackConflict('Import not found.');
    if (batch.status === 'rolled_back') throw new ImportRollbackConflict('This import has already been rolled back.');
    if (batch.status === 'processing' || batch.status === 'rollback_in_progress') {
      throw new ImportRollbackConflict('This import is still processing or another rollback is in progress.');
    }
    validateRollbackEvidence(batch);
    if (!await importRollbackCompleteness(transaction, batch.id, batch.totalRows)) {
      throw new ImportRollbackConflict('This import does not have complete row progress and change snapshots. Its rollback eligibility could not be verified.');
    }

    await lockRollbackRecords(transaction, batch.changes);
    batch = await transaction.importBatch.findUnique({
      where: { id: importBatchId },
      include: { changes: { orderBy: { sequence: 'desc' } } },
    });
    if (!batch) throw new ImportRollbackConflict('Import not found.');
    validateRollbackEvidence(batch);
    if (!await importRollbackCompleteness(transaction, batch.id, batch.totalRows)) {
      throw new ImportRollbackConflict('This import does not have complete row progress and change snapshots. Its rollback eligibility could not be verified.');
    }
    await validateNoCrossBatchChanges(transaction, batch);
    await validateCurrentRollbackState(transaction, batch.changes);

    const ccmIds = [...new Set(batch.changes.map(({ ccmId }) => ccmId).filter(Boolean))].sort();
    for (const ccmId of ccmIds) await lockCcmAllocationTeam(transaction, ccmId);

    await transaction.importBatch.update({
      where: { id: batch.id },
      data: { status: 'rollback_in_progress', rollbackError: null },
    });
    const now = new Date();
    let reversedChanges = 0;
    for (const change of batch.changes) {
      await reverseChange(transaction, change, adminId);
      reversedChanges += 1;
    }
    if (batch.changes.length) {
      await transaction.importChangeLog.updateMany({
        where: { importBatchId: batch.id, rollbackStatus: 'pending' },
        data: { rollbackStatus: 'rolled_back', rolledBackAt: now, rollbackError: null },
      });
    }

    const updatedBatch = await transaction.importBatch.update({
      where: { id: batch.id },
      data: { status: 'rolled_back', rolledBackAt: now, rollbackError: null },
    });
    if (batch.importType === 'monthly_customer_data') {
      await transaction.monthlyCustomerDataImport.updateMany({
        where: { importBatchId: batch.id },
        data: { status: 'rolled_back' },
      });
    }
    await transaction.auditLog.create({
      data: {
        userId: adminId,
        entityType: 'ImportBatch',
        entityId: batch.id,
        action: batch.importType === 'monthly_customer_data'
          ? 'MONTHLY_CUSTOMER_DATA_IMPORT_ROLLED_BACK'
          : 'REPAIR_ORDER_IMPORT_ROLLED_BACK',
        details: JSON.stringify({ changeCount: batch.changes.length }),
      },
    });
    return { batch: updatedBatch, reversedChanges };
  }, { isolationLevel: 'Serializable' });
}
