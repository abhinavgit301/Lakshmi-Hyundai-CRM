import { prisma } from '../config/prisma.js';
import { lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { importRollbackCompleteness } from '../utils/importBatchStats.js';

const entityDelegates = {
  Customer: 'customer',
  Vehicle: 'vehicle',
  WorkshopVisit: 'workshopVisit',
  MasterCallList: 'masterCallList',
  Allocation: 'allocation',
  VINConflictReview: 'vINConflictReview',
};

const entityLabels = {
  Customer: 'customer',
  Vehicle: 'vehicle',
  WorkshopVisit: 'repair order',
  MasterCallList: 'Master Call List entry',
  Allocation: 'CRE allocation',
  VINConflictReview: 'VIN conflict review',
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

function snapshotMatches(record, expected, requireFullRecord) {
  if (requireFullRecord) {
    const expectedFields = Object.keys(expected || {}).sort();
    const actualFields = Object.keys(record || {}).sort();
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
      transaction.masterCallList.count({ where: { vin: change.after?.vin } }),
      transaction.monthlyCustomerDataEntry.count({ where: { vehicleId: change.entityId } }),
      transaction.freeServiceMilestone.count({ where: { vehicleId: change.entityId } }),
    ]);
    if (visits + calls + followUps + appointments + ownership + allocations + callList + monthlyEntries + milestones) {
      throw new ImportRollbackConflict('The imported vehicle has later service, allocation, call-list, call, appointment, ownership, or monthly-data dependencies. Remove or reassign those records before retrying rollback.');
    }
  }
}

async function reverseChange(transaction, change) {
  if (change.rollbackStatus === 'permanently_deleted') return;
  const { delegate, record } = await findEntity(transaction, change.entityType, change.entityId);
  if (!snapshotMatches(record, change.after, change.operation === 'CREATE')) {
    throw new ImportRollbackConflict(`The ${entityLabels[change.entityType]} has changed since this import. Its later changes were preserved; resolve the conflict before retrying rollback.`);
  }

  if (change.operation === 'CREATE') {
    await ensureNoReferences(transaction, change);
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
  await delegate.update({
    where: { id: change.entityId },
    data: restoredValues,
  });
}

export async function rollbackImportBatch(importBatchId, adminId, database = prisma) {
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "import_batches" WHERE "id" = ${importBatchId} FOR UPDATE`;
    const batch = await transaction.importBatch.findUnique({
      where: { id: importBatchId },
      include: { changes: { orderBy: { sequence: 'desc' } } },
    });
    if (!batch) throw new ImportRollbackConflict('Import not found.');
    if (batch.status === 'rolled_back') throw new ImportRollbackConflict('This import has already been rolled back.');
    if (batch.status === 'processing' || batch.status === 'rollback_in_progress') {
      throw new ImportRollbackConflict('This import is still processing or another rollback is in progress.');
    }
    if (!['completed', 'failed'].includes(batch.status)) {
      throw new ImportRollbackConflict('Only completed or failed imports can be rolled back.');
    }
    if (!batch.rollbackSupported) {
      throw new ImportRollbackConflict('This historical import has no verified change snapshots and cannot be safely rolled back.');
    }
    if (!await importRollbackCompleteness(transaction, batch.id, batch.totalRows)) {
      throw new ImportRollbackConflict('This import does not have complete row progress and change snapshots. Its rollback eligibility could not be verified.');
    }

    const ccmIds = [...new Set(batch.changes.map(({ ccmId }) => ccmId).filter(Boolean))].sort();
    for (const ccmId of ccmIds) await lockCcmAllocationTeam(transaction, ccmId);

    await transaction.importBatch.update({
      where: { id: batch.id },
      data: { status: 'rollback_in_progress', rollbackError: null },
    });
    const now = new Date();
    let reversedChanges = 0;
    for (const change of batch.changes) {
      if (change.rollbackStatus === 'permanently_deleted') continue;
      await reverseChange(transaction, change);
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
    await transaction.auditLog.create({
      data: {
        userId: adminId,
        entityType: 'ImportBatch',
        entityId: batch.id,
        action: 'REPAIR_ORDER_IMPORT_ROLLED_BACK',
        details: JSON.stringify({ changeCount: batch.changes.length }),
      },
    });
    return { batch: updatedBatch, reversedChanges };
  }, { isolationLevel: 'Serializable' });
}
