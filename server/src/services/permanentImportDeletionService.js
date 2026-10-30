import { createHash } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { importRollbackCompleteness } from '../utils/importBatchStats.js';

const DELETION_MARKER = 'permanently_deleted';
const entityDelegates = {
  Customer: 'customer',
  Vehicle: 'vehicle',
  WorkshopVisit: 'workshopVisit',
  MasterCallList: 'masterCallList',
  Allocation: 'allocation',
  VINConflictReview: 'vINConflictReview',
};
const entityNames = Object.keys(entityDelegates);
const dateFields = {
  Customer: new Set(['createdAt', 'updatedAt']),
  Vehicle: new Set(['saleDate', 'createdAt', 'updatedAt']),
  WorkshopVisit: new Set(['visitDate', 'closingDate', 'gpDate', 'createdAt', 'updatedAt']),
  MasterCallList: new Set(['createdAt', 'updatedAt']),
  Allocation: new Set(['createdAt', 'updatedAt']),
  VINConflictReview: new Set(['createdAt', 'updatedAt']),
};

export class PermanentImportDeletionConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentImportDeletionConflict';
  }
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return stableValue(value.toJSON());
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function emptyIds() {
  return Object.fromEntries(entityNames.map((entity) => [entity, new Set()]));
}

function addIds(target, entityType, ids) {
  if (!target[entityType]) throw new PermanentImportDeletionConflict(`Unsupported import change type: ${entityType}.`);
  for (const id of ids) if (id) target[entityType].add(id);
}

function getIds(ids, entityType) {
  return [...ids[entityType]].sort();
}

function buildToken(plan) {
  const tokenSource = {
    batchId: plan.batch.id,
    batchStatus: plan.batch.status,
    batchCreatedAt: plan.batch.createdAt,
    fileName: plan.batch.fileName,
    batchChanges: plan.batch.changes.map(({ id, entityType, entityId, operation, before, after, sequence }) => ({
      id, entityType, entityId, operation, before, after, sequence,
    })),
    deleteIds: Object.fromEntries(entityNames.map((type) => [type, getIds(plan.deleteIds, type)])),
    deletionIds: Object.fromEntries(entityNames.map((type) => [type, getIds(plan.deletionIds, type)])),
    recordsAlreadyAbsent: plan.recordsAlreadyAbsent,
    relatedIds: plan.relatedIds,
    monthlyEntryDetaches: plan.monthlyEntryDetaches,
    restoreUpdates: plan.restoreUpdates,
    fingerprints: plan.fingerprints,
    affectedBatchIds: plan.affectedBatches.map(({ id, status }) => [id, status]),
    affectedChangeLogs: plan.changeLogs.map(({ id, importBatchId, rollbackStatus }) => [id, importBatchId, rollbackStatus]),
  };
  return createHash('sha256').update(JSON.stringify(stableValue(tokenSource))).digest('hex');
}

async function loadDeletionPlan(transaction, importBatchId) {
  const batch = await transaction.importBatch.findUnique({
    where: { id: importBatchId },
    include: {
      changes: { orderBy: [{ sequence: 'asc' }, { id: 'asc' }] },
      rowProgress: {
        select: {
          id: true,
          importBatchId: true,
          rowNumber: true,
          status: true,
          outcome: true,
          mutationState: true,
          loggedChangeCount: true,
        },
      },
    },
  });
  if (!batch) throw new PermanentImportDeletionConflict('Import not found.');
  if (batch.status === DELETION_MARKER) {
    return {
      batch,
      alreadyDeleted: true,
      deleteIds: emptyIds(),
      deletionIds: emptyIds(),
      recordsAlreadyAbsent: [],
      relatedIds: { calls: [], followUps: [], appointments: [], appointmentEvents: [], ownership: [], milestones: [], monthlyEntries: [] },
      monthlyEntryDetaches: [],
      restoreUpdates: [],
      fingerprints: [],
      affectedBatches: [],
      changeLogs: [],
      summary: emptySummary(),
    };
  }
  if (!['completed', 'failed'].includes(batch.status)) {
    throw new PermanentImportDeletionConflict('Only completed or failed imports can be permanently deleted.');
  }
  if (!batch.rollbackSupported
    || !await importRollbackCompleteness(transaction, batch.id, batch.totalRows)) {
    throw new PermanentImportDeletionConflict('The import does not have complete verified row progress and change snapshots. Its deletion scope cannot be determined safely.');
  }

  const deleteIds = emptyIds();
  const directlyCreatedIds = emptyIds();
  for (const change of batch.changes) {
    if (!entityDelegates[change.entityType]) {
      throw new PermanentImportDeletionConflict(`The import contains an unsupported ${change.entityType} change. Its deletion scope cannot be determined safely.`);
    }
    if (change.operation === 'CREATE') {
      addIds(deleteIds, change.entityType, [change.entityId]);
      addIds(directlyCreatedIds, change.entityType, [change.entityId]);
    }
  }

  const createdCustomerIds = getIds(deleteIds, 'Customer');
  const createdVehicleIds = new Set(getIds(deleteIds, 'Vehicle'));
  const customerVehicles = createdCustomerIds.length
    ? await transaction.vehicle.findMany({
      where: { customerId: { in: createdCustomerIds } },
      select: { id: true, vin: true, customerId: true, ccmId: true, updatedAt: true },
    })
    : [];
  if (customerVehicles.length) {
    const vehicleCreationLogs = await transaction.importChangeLog.findMany({
      where: {
        entityType: 'Vehicle',
        entityId: { in: customerVehicles.map(({ id }) => id) },
        operation: 'CREATE',
      },
      include: { batch: { select: { id: true, createdAt: true, status: true } } },
    });
    const logsByVehicle = new Map();
    for (const change of vehicleCreationLogs) {
      const current = logsByVehicle.get(change.entityId) || [];
      current.push(change);
      logsByVehicle.set(change.entityId, current);
    }
    for (const vehicle of customerVehicles) {
      if (createdVehicleIds.has(vehicle.id)) continue;
      const creations = logsByVehicle.get(vehicle.id) || [];
      if (creations.length !== 1) {
        throw new PermanentImportDeletionConflict('An imported customer is linked to a vehicle without verified ownership by this import or a later import. Reassign or resolve the shared vehicle before permanent deletion.');
      }
      const [creation] = creations;
      if (creation.batch.createdAt <= batch.createdAt
        || creation.rollbackStatus === 'rolled_back'
        || creation.rollbackStatus === DELETION_MARKER) {
        throw new PermanentImportDeletionConflict('An imported customer is linked to a vehicle without verified ownership by this import or a later import. Reassign or resolve the shared vehicle before permanent deletion.');
      }
      if (creation.batch.status === 'processing' || creation.batch.status === 'rollback_in_progress') {
        throw new PermanentImportDeletionConflict('A later import affecting this customer is still processing or being rolled back.');
      }
      createdVehicleIds.add(vehicle.id);
      addIds(deleteIds, 'Vehicle', [vehicle.id]);
    }
  }

  const customerIds = getIds(deleteIds, 'Customer');
  const vehicleIds = getIds(deleteIds, 'Vehicle');
  const targetCreatedVins = batch.changes
    .filter((change) => change.entityType === 'Vehicle' && change.operation === 'CREATE')
    .map((change) => change.after?.vin)
    .filter(Boolean);
  const customerRows = customerIds.length
    ? await transaction.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, ccmId: true, updatedAt: true },
    })
    : [];
  const vehicleRows = vehicleIds.length
    ? await transaction.vehicle.findMany({
      where: { id: { in: vehicleIds } },
      select: { id: true, vin: true, customerId: true, ccmId: true, updatedAt: true },
    })
    : [];
  const vins = [...new Set([...targetCreatedVins, ...vehicleRows.map(({ vin }) => vin).filter(Boolean)])];
  const visitWhere = {
    OR: [
      ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
      ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
      ...(getIds(deleteIds, 'WorkshopVisit').length ? [{ id: { in: getIds(deleteIds, 'WorkshopVisit') } }] : []),
    ],
  };
  const visits = visitWhere.OR.length
    ? await transaction.workshopVisit.findMany({ where: visitWhere, select: { id: true, customerId: true, vehicleId: true, updatedAt: true } })
    : [];
  addIds(deleteIds, 'WorkshopVisit', visits.map(({ id }) => id));

  const masterWhere = {
    OR: [
      ...(vins.length ? [{ vin: { in: vins } }] : []),
      ...(getIds(deleteIds, 'MasterCallList').length ? [{ id: { in: getIds(deleteIds, 'MasterCallList') } }] : []),
    ],
  };
  const masterCallListRows = masterWhere.OR.length
    ? await transaction.masterCallList.findMany({
      where: masterWhere,
      select: { id: true, vin: true, ccmId: true, updatedAt: true },
    })
    : [];
  addIds(deleteIds, 'MasterCallList', masterCallListRows.map(({ id }) => id));

  const allocations = vehicleIds.length || getIds(deleteIds, 'Allocation').length
    ? await transaction.allocation.findMany({
      where: {
        OR: [
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
          ...(getIds(deleteIds, 'Allocation').length ? [{ id: { in: getIds(deleteIds, 'Allocation') } }] : []),
        ],
      },
      select: { id: true, vehicleId: true, ccmId: true, updatedAt: true },
    })
    : [];
  addIds(deleteIds, 'Allocation', allocations.map(({ id }) => id));

  const milestones = vehicleIds.length
    ? await transaction.freeServiceMilestone.findMany({
      where: { vehicleId: { in: vehicleIds } },
      select: { id: true, vehicleId: true, updatedAt: true },
    })
    : [];
  const milestoneIds = milestones.map(({ id }) => id);
  const calls = customerIds.length || vehicleIds.length || milestoneIds.length
    ? await transaction.callLog.findMany({
      where: {
        OR: [
          ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
          ...(milestoneIds.length ? [{ milestoneId: { in: milestoneIds } }] : []),
        ],
      },
      select: { id: true, customerId: true, vehicleId: true, createdAt: true },
    })
    : [];
  const followUps = customerIds.length || vehicleIds.length || milestoneIds.length
    ? await transaction.followUp.findMany({
      where: {
        OR: [
          ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
          ...(milestoneIds.length ? [{ milestoneId: { in: milestoneIds } }] : []),
        ],
      },
      select: { id: true, customerId: true, vehicleId: true, createdAt: true, updatedAt: true },
    })
    : [];
  const appointments = customerIds.length || vehicleIds.length
    ? await transaction.appointment.findMany({
      where: {
        OR: [
          ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
        ],
      },
      select: { id: true, customerId: true, vehicleId: true, createdAt: true, updatedAt: true },
    })
    : [];
  const appointmentIds = appointments.map(({ id }) => id);
  const appointmentEvents = appointmentIds.length
    ? await transaction.appointmentEvent.findMany({
      where: { appointmentId: { in: appointmentIds } },
      select: { id: true, appointmentId: true, createdAt: true },
    })
    : [];
  const ownership = vehicleIds.length
    ? await transaction.vehicleOwnershipHistory.findMany({
      where: { vehicleId: { in: vehicleIds } },
      select: { id: true, vehicleId: true, changedAt: true },
    })
    : [];
  const monthlyEntries = customerIds.length || vehicleIds.length
    ? await transaction.monthlyCustomerDataEntry.findMany({
      where: {
        OR: [
          ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
        ],
      },
      select: { id: true, customerId: true, vehicleId: true, createdAt: true },
    })
    : [];
  const conflictReviews = vins.length || getIds(deleteIds, 'VINConflictReview').length
    ? await transaction.vINConflictReview.findMany({
      where: {
        OR: [
          ...(vins.length ? [{ vin: { in: vins } }] : []),
          ...(getIds(deleteIds, 'VINConflictReview').length ? [{ id: { in: getIds(deleteIds, 'VINConflictReview') } }] : []),
        ],
      },
      select: { id: true, vin: true, createdAt: true, updatedAt: true },
    })
    : [];
  addIds(deleteIds, 'VINConflictReview', conflictReviews.map(({ id }) => id));

  const relatedIds = {
    calls: calls.map(({ id }) => id).sort(),
    followUps: followUps.map(({ id }) => id).sort(),
    appointments: appointments.map(({ id }) => id).sort(),
    appointmentEvents: appointmentEvents.map(({ id }) => id).sort(),
    ownership: ownership.map(({ id }) => id).sort(),
    milestones: milestoneIds.sort(),
    monthlyEntries: monthlyEntries.map(({ id }) => id).sort(),
  };
  for (const change of batch.changes) {
    if (change.operation === 'CREATE' && !deleteIds[change.entityType].has(change.entityId)) {
      throw new PermanentImportDeletionConflict(`A created ${change.entityType} no longer belongs to the deletion scope. Refresh the preview or investigate its references.`);
    }
  }

  const existingRowsByType = {
    Customer: customerRows,
    Vehicle: vehicleRows,
    WorkshopVisit: visits,
    MasterCallList: masterCallListRows,
    Allocation: allocations,
    VINConflictReview: conflictReviews,
  };
  const recordsAlreadyAbsent = [];
  const deletionIds = Object.fromEntries(entityNames.map((type) => [type, new Set(deleteIds[type])]));
  for (const type of entityNames) {
    const existingIds = new Set((existingRowsByType[type] || []).map(({ id }) => id));
    for (const id of directlyCreatedIds[type]) {
      if (existingIds.has(id)) continue;
      deletionIds[type].delete(id);
      recordsAlreadyAbsent.push({ entityType: type, entityId: id, operation: 'CREATE' });
    }
  }
  recordsAlreadyAbsent.sort((left, right) => `${left.entityType}:${left.entityId}`.localeCompare(`${right.entityType}:${right.entityId}`));

  const allDeletedEntityIds = new Map();
  for (const type of entityNames) {
    const ids = [...new Set([...getIds(deleteIds, type), ...getIds(directlyCreatedIds, type)])].sort();
    if (ids.length) allDeletedEntityIds.set(type, ids);
  }
  const logOr = [...allDeletedEntityIds].map(([entityType, entityId]) => ({ entityType, entityId: { in: entityId } }));
  const relatedLogs = logOr.length
    ? await transaction.importChangeLog.findMany({
      where: { OR: logOr },
      include: {
        batch: { select: { id: true, fileName: true, status: true, createdAt: true } },
        rowProgress: { select: { rowNumber: true } },
      },
    })
    : [];
  const affectedBatchMap = new Map();
  for (const change of relatedLogs) {
    if (change.importBatchId === batch.id) continue;
    const affectedBatch = affectedBatchMap.get(change.importBatchId) || {
      ...change.batch,
      invalidatedChanges: 0,
      invalidatedRows: new Set(),
    };
    affectedBatch.invalidatedChanges += change.rollbackStatus === DELETION_MARKER ? 0 : 1;
    if (change.rowProgress?.rowNumber != null) affectedBatch.invalidatedRows.add(change.rowProgress.rowNumber);
    affectedBatchMap.set(change.importBatchId, affectedBatch);
  }
  const affectedBatches = [...affectedBatchMap.values()]
    .filter(({ invalidatedChanges }) => invalidatedChanges > 0)
    .map(({ invalidatedRows, ...item }) => ({ ...item, invalidatedRows: [...invalidatedRows].sort((a, b) => a - b) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (affectedBatches.some(({ status }) => status === 'processing' || status === 'rollback_in_progress')) {
    throw new PermanentImportDeletionConflict('A later import affecting these records is still processing or being rolled back. Wait for it to finish and preview again.');
  }

  const restoreUpdates = await buildRestoreUpdates(transaction, batch, deleteIds, recordsAlreadyAbsent);
  recordsAlreadyAbsent.sort((left, right) => `${left.entityType}:${left.entityId}:${left.operation}`.localeCompare(`${right.entityType}:${right.entityId}:${right.operation}`));
  const deletedCustomerIds = new Set(customerIds);
  const deletedVehicleIds = new Set(vehicleIds);
  const monthlyEntryDetaches = monthlyEntries.map(({ id, customerId, vehicleId }) => ({
    id,
    customerId,
    vehicleId,
    nextCustomerId: deletedCustomerIds.has(customerId) ? null : customerId,
    nextVehicleId: deletedVehicleIds.has(vehicleId) ? null : vehicleId,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const fingerprints = [
    ...customerRows.map((row) => ['Customer', stableValue(row)]),
    ...vehicleRows.map((row) => ['Vehicle', stableValue(row)]),
    ...visits.map((row) => ['WorkshopVisit', stableValue(row)]),
    ...masterCallListRows.map((row) => ['MasterCallList', stableValue(row)]),
    ...allocations.map((row) => ['Allocation', stableValue(row)]),
    ...calls.map((row) => ['CallLog', stableValue(row)]),
    ...followUps.map((row) => ['FollowUp', stableValue(row)]),
    ...appointments.map((row) => ['Appointment', stableValue(row)]),
    ...appointmentEvents.map((row) => ['AppointmentEvent', stableValue(row)]),
    ...ownership.map((row) => ['VehicleOwnershipHistory', stableValue(row)]),
    ...monthlyEntries.map((row) => ['MonthlyCustomerDataEntry', stableValue(row)]),
    ...milestones.map((row) => ['FreeServiceMilestone', stableValue(row)]),
    ...conflictReviews.map((row) => ['VINConflictReview', stableValue(row)]),
  ].sort((left, right) => `${left[0]}:${left[1].id}`.localeCompare(`${right[0]}:${right[1].id}`));
  const ccmIds = [...new Set([
    ...batch.changes.map(({ ccmId }) => ccmId),
    ...relatedLogs.map(({ ccmId }) => ccmId),
    ...customerRows.map(({ ccmId }) => ccmId),
    ...vehicleRows.map(({ ccmId }) => ccmId),
    ...masterCallListRows.map(({ ccmId }) => ccmId),
    ...allocations.map(({ ccmId }) => ccmId),
  ].filter(Boolean))].sort();

  const counts = {
    customers: getIds(deletionIds, 'Customer').length,
    vehicles: getIds(deletionIds, 'Vehicle').length,
    repairOrders: getIds(deletionIds, 'WorkshopVisit').length,
    callListRecords: getIds(deletionIds, 'MasterCallList').length,
    allocations: getIds(deletionIds, 'Allocation').length,
    calls: calls.length,
    appointments: appointments.length,
    followUps: followUps.length,
    ownershipRecords: ownership.length,
    freeServiceMilestones: milestones.length,
    appointmentEvents: appointmentEvents.length,
    vinConflictReviews: getIds(deletionIds, 'VINConflictReview').length,
    monthlyEntriesDetached: monthlyEntries.length,
  };
  const directCount = entityNames.reduce((sum, type) => sum + [...directlyCreatedIds[type]].filter((id) => deletionIds[type].has(id)).length, 0);
  const totalDeleted = Object.entries(counts).reduce((sum, [key, value]) => sum + (key === 'monthlyEntriesDetached' ? 0 : value), 0);
  const summary = {
    directlyAffectedRecords: directCount,
    dependentRecords: Math.max(0, totalDeleted - directCount),
    totalRecordsDeleted: totalDeleted,
    laterImportBatchesAffected: affectedBatches.length,
    existingRecordsRestored: new Set(restoreUpdates.map(({ entityType, entityId }) => `${entityType}:${entityId}`)).size,
    counts,
  };
  return {
    batch,
    alreadyDeleted: false,
    deleteIds,
    deletionIds,
    recordsAlreadyAbsent,
    monthlyEntryDetaches,
    restoreUpdates,
    fingerprints,
    affectedBatches,
    changeLogs: relatedLogs,
    relatedIds,
    ccmIds,
    summary,
  };
}

async function buildRestoreUpdates(transaction, batch, deleteIds, recordsAlreadyAbsent) {
  const grouped = new Map();
  for (const change of batch.changes) {
    if (change.operation !== 'UPDATE') continue;
    if (deleteIds[change.entityType]?.has(change.entityId)) continue;
    const key = `${change.entityType}:${change.entityId}`;
    const group = grouped.get(key) || { entityType: change.entityType, entityId: change.entityId, changes: [] };
    group.changes.push(change);
    grouped.set(key, group);
  }

  const allChangesForEntities = grouped.size
    ? await transaction.importChangeLog.findMany({
      where: {
        operation: 'UPDATE',
        OR: [...grouped.values()].map(({ entityType, entityId }) => ({ entityType, entityId })),
      },
      include: { batch: { select: { id: true, createdAt: true } } },
    })
    : [];
  const updates = [];
  for (const group of grouped.values()) {
    group.changes.sort((left, right) => left.sequence - right.sequence);
    const delegate = transaction[entityDelegates[group.entityType]];
    const record = await delegate.findUnique({ where: { id: group.entityId } });
    if (!record) {
      recordsAlreadyAbsent.push({ entityType: group.entityType, entityId: group.entityId, operation: 'UPDATE' });
      continue;
    }

    const originalBefore = {};
    const targetAfter = {};
    for (const change of group.changes) {
      for (const [field, value] of Object.entries(change.before || {})) {
        if (!Object.hasOwn(originalBefore, field)) originalBefore[field] = value;
      }
      Object.assign(targetAfter, change.after || {});
    }
    const laterChanges = allChangesForEntities
      .filter((change) => change.entityType === group.entityType
        && change.entityId === group.entityId
        && change.importBatchId !== batch.id
        && change.batch.createdAt > batch.createdAt
        && change.rollbackStatus !== 'rolled_back'
        && change.rollbackStatus !== DELETION_MARKER)
      .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence);
    const preservedValues = {};
    for (const field of Object.keys(originalBefore)) {
      const laterFieldChanges = laterChanges.filter((change) => Object.hasOwn(change.after || {}, field));
      const expected = laterFieldChanges.length
        ? laterFieldChanges[laterFieldChanges.length - 1].after[field]
        : targetAfter[field];
      if (!Object.hasOwn(targetAfter, field) || !sameValue(record[field], expected)) {
        throw new PermanentImportDeletionConflict(`The ${group.entityType} ${group.entityId} has untracked or conflicting changes. Its previous values cannot be restored safely.`);
      }
      preservedValues[field] = laterFieldChanges.length ? expected : originalBefore[field];
    }
    updates.push({
      entityType: group.entityType,
      entityId: group.entityId,
      data: Object.fromEntries(Object.entries(preservedValues).map(([field, value]) => [
        field,
        dateFields[group.entityType]?.has(field) && value !== null ? new Date(value) : value,
      ])),
      before: targetAfter,
      after: preservedValues,
    });
  }
  return updates.sort((left, right) => `${left.entityType}:${left.entityId}`.localeCompare(`${right.entityType}:${right.entityId}`));
}

function emptySummary() {
  return {
    directlyAffectedRecords: 0,
    dependentRecords: 0,
    totalRecordsDeleted: 0,
    laterImportBatchesAffected: 0,
    existingRecordsRestored: 0,
    counts: {
      customers: 0, vehicles: 0, repairOrders: 0, callListRecords: 0, allocations: 0,
      calls: 0, appointments: 0, followUps: 0, ownershipRecords: 0,
      freeServiceMilestones: 0, appointmentEvents: 0, vinConflictReviews: 0,
      monthlyEntriesDetached: 0,
    },
  };
}

export async function previewPermanentImportDeletion(importBatchId, database = prisma) {
  return database.$transaction(async (transaction) => {
    const plan = await loadDeletionPlan(transaction, importBatchId);
    return {
      importId: plan.batch.id,
      fileName: plan.batch.fileName,
      importedAt: plan.batch.createdAt,
      status: plan.batch.status,
      alreadyDeleted: plan.alreadyDeleted,
      confirmationToken: plan.alreadyDeleted ? null : buildToken(plan),
      affectedImportBatches: plan.affectedBatches.map(({ id, fileName, invalidatedChanges, invalidatedRows }) => ({
        id, fileName, invalidatedChanges, invalidatedRows,
      })),
      restoredRecords: plan.restoreUpdates.map(({ entityType, entityId }) => ({ entityType, entityId })),
      recordsAlreadyAbsent: plan.recordsAlreadyAbsent || [],
      ...plan.summary,
    };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function permanentlyDeleteImportBatch(importBatchId, adminId, confirmationToken, database = prisma) {
  if (!confirmationToken) throw new PermanentImportDeletionConflict('Refresh the permanent-deletion preview and confirm again.');
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "import_batches" WHERE "id" = ${importBatchId} FOR UPDATE`;
    let plan = await loadDeletionPlan(transaction, importBatchId);
    if (plan.alreadyDeleted) return { status: DELETION_MARKER, alreadyDeleted: true, summary: emptySummary() };
    for (const affectedBatch of plan.affectedBatches) {
      await transaction.$queryRaw`SELECT "id" FROM "import_batches" WHERE "id" = ${affectedBatch.id} FOR UPDATE`;
    }
    for (const ccmId of plan.ccmIds) await lockCcmAllocationTeam(transaction, ccmId);
    plan = await loadDeletionPlan(transaction, importBatchId);
    if (buildToken(plan) !== confirmationToken) {
      throw new PermanentImportDeletionConflict('The deletion scope changed after preview. Review the updated preview and confirm again.');
    }

    const now = new Date();
    const deleteCount = async (delegate, ids) => {
      if (!ids.length) return 0;
      const result = await transaction[delegate].deleteMany({ where: { id: { in: ids } } });
      if (result.count !== ids.length) {
        throw new PermanentImportDeletionConflict(`The deletion plan changed while removing ${delegate} records. No changes were committed.`);
      }
      return result.count;
    };

    for (const update of plan.restoreUpdates) {
      await transaction[entityDelegates[update.entityType]].update({
        where: { id: update.entityId },
        data: update.data,
      });
    }
    for (const entry of plan.monthlyEntryDetaches) {
      const detached = await transaction.monthlyCustomerDataEntry.updateMany({
        where: { id: entry.id, customerId: entry.customerId, vehicleId: entry.vehicleId },
        data: { customerId: entry.nextCustomerId, vehicleId: entry.nextVehicleId },
      });
      if (detached.count !== 1) {
        throw new PermanentImportDeletionConflict('Monthly customer data changed while preparing deletion. No changes were committed.');
      }
    }

    await deleteCount('appointmentEvent', plan.relatedIds.appointmentEvents);
    await deleteCount('callLog', plan.relatedIds.calls);
    await deleteCount('followUp', plan.relatedIds.followUps);
    await deleteCount('vehicleOwnershipHistory', plan.relatedIds.ownership);
    await deleteCount('allocation', getIds(plan.deletionIds, 'Allocation'));
    await deleteCount('workshopVisit', getIds(plan.deletionIds, 'WorkshopVisit'));
    await deleteCount('masterCallList', getIds(plan.deletionIds, 'MasterCallList'));
    await deleteCount('vINConflictReview', getIds(plan.deletionIds, 'VINConflictReview'));
    await deleteCount('freeServiceMilestone', plan.relatedIds.milestones);
    await deleteCount('appointment', plan.relatedIds.appointments);
    await deleteCount('vehicle', getIds(plan.deletionIds, 'Vehicle'));
    await deleteCount('customer', getIds(plan.deletionIds, 'Customer'));

    const changedLogsById = new Map([...plan.changeLogs, ...plan.batch.changes].map((change) => [change.id, change]));
    const changedLogs = [...changedLogsById.values()];
    const affectedChangeIds = changedLogs.map(({ id }) => id);
    if (affectedChangeIds.length) {
      const expectedInvalidationCount = changedLogs.filter(({ rollbackStatus }) => rollbackStatus !== DELETION_MARKER).length;
      const invalidated = await transaction.importChangeLog.updateMany({
        where: { id: { in: affectedChangeIds }, rollbackStatus: { not: DELETION_MARKER } },
        data: {
          rollbackStatus: DELETION_MARKER,
          rolledBackAt: now,
          rollbackError: `Invalidated by permanent deletion of import ${plan.batch.id}.`,
        },
      });
      if (invalidated.count !== expectedInvalidationCount) {
        throw new PermanentImportDeletionConflict('Import change history changed while preparing deletion. No changes were committed.');
      }
    }
    const updatedBatch = await transaction.importBatch.update({
      where: { id: plan.batch.id },
      data: {
        status: DELETION_MARKER,
        rollbackSupported: false,
        rolledBackAt: now,
        rollbackError: `Permanently deleted by Admin ${adminId}.`,
      },
    });
    for (const affectedBatch of plan.affectedBatches) {
      await transaction.auditLog.create({
        data: {
          userId: adminId,
          entityType: 'ImportBatch',
          entityId: affectedBatch.id,
          action: 'REPAIR_ORDER_IMPORT_CASCADE_INVALIDATED',
          details: JSON.stringify({
            causeImportId: plan.batch.id,
            fileName: plan.batch.fileName,
            invalidatedChanges: affectedBatch.invalidatedChanges,
            invalidatedRows: affectedBatch.invalidatedRows,
          }),
        },
      });
    }
    await transaction.auditLog.create({
      data: {
        userId: adminId,
        entityType: 'ImportBatch',
        entityId: plan.batch.id,
        action: 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED',
        details: JSON.stringify({
          importId: plan.batch.id,
          fileName: plan.batch.fileName,
          deletedAt: now.toISOString(),
          counts: plan.summary.counts,
          directlyAffectedRecords: plan.summary.directlyAffectedRecords,
          dependentRecords: plan.summary.dependentRecords,
          totalRecordsDeleted: plan.summary.totalRecordsDeleted,
          laterImportBatchesAffected: plan.affectedBatches.length,
          restoredRecords: plan.restoreUpdates.map(({ entityType, entityId }) => ({ entityType, entityId })),
          monthlyEntriesDetached: plan.monthlyEntryDetaches.length,
          recordsAlreadyAbsent: plan.recordsAlreadyAbsent,
        }),
      },
    });
    return {
      status: updatedBatch.status,
      alreadyDeleted: false,
      summary: plan.summary,
    };
  }, { isolationLevel: 'Serializable' });
}
