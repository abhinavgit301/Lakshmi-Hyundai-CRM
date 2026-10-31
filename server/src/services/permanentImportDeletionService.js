import { createHash } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { importBatchMutationEvidenceIsComplete, importChangeLogIsComplete, importRollbackCompleteness } from '../utils/importBatchStats.js';
import { normalizeRepairOrderNo } from '../utils/repairOrderIdentity.js';

const DELETION_MARKER = 'permanently_deleted';
const entityConfig = {
  Customer: { delegate: 'customer', table: 'customers', label: 'Customer' },
  Vehicle: { delegate: 'vehicle', table: 'vehicles', label: 'Vehicle' },
  WorkshopVisit: { delegate: 'workshopVisit', table: 'workshop_visits', label: 'WorkshopVisit' },
  MasterCallList: { delegate: 'masterCallList', table: 'master_call_lists', label: 'MasterCallList' },
  Allocation: { delegate: 'allocation', table: 'allocations', label: 'Allocation' },
  VINConflictReview: { delegate: 'vINConflictReview', table: 'vin_conflict_reviews', label: 'VINConflictReview' },
  MonthlyCustomerDataEntry: { delegate: 'monthlyCustomerDataEntry', table: 'monthly_customer_data_entries', label: 'MonthlyCustomerDataEntry' },
};
const entityTypes = Object.keys(entityConfig);
const dateFields = new Set(['createdAt', 'updatedAt', 'saleDate', 'visitDate', 'closingDate', 'gpDate']);

export class PermanentImportDeletionConflict extends Error {
  constructor(message, blockers = []) {
    super(message);
    this.name = 'PermanentImportDeletionConflict';
    this.blockers = blockers;
  }
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return stableValue(value.toJSON());
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function recordMatchesExpected(entityType, record, expected) {
  const legacyNormalizedRepairOrder = entityType === 'WorkshopVisit'
    && !Object.hasOwn(expected || {}, 'normalizedRepairOrderNo')
    && Object.hasOwn(record || {}, 'normalizedRepairOrderNo');
  if (!legacyNormalizedRepairOrder) return sameValue(record, expected);
  if (record.normalizedRepairOrderNo !== normalizeRepairOrderNo(expected.repairOrderNo)) return false;
  const comparableRecord = Object.fromEntries(Object.entries(record)
    .filter(([field]) => field !== 'normalizedRepairOrderNo'));
  return sameValue(comparableRecord, expected);
}

function sortedChanges(changes) {
  return [...changes].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function addBlocker(blockers, blocker) {
  const key = `${blocker.code}:${blocker.entityType || ''}:${blocker.entityId || ''}:${blocker.relatedEntityType || ''}:${blocker.relatedEntityId || ''}:${blocker.field || ''}`;
  if (!blockers.some((item) => item.key === key)) blockers.push({ ...blocker, key });
}

function publicBlockers(blockers) {
  return [...blockers]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, ...blocker }) => blocker);
}

function recordLabel(entityType, record) {
  if (!record) return { id: null };
  const label = { id: record.id };
  if (entityType === 'Customer') Object.assign(label, { name: record.fullName, mobileNumber: record.mobileNumber });
  if (entityType === 'Vehicle') Object.assign(label, { vin: record.vin, registrationNumber: record.registrationNumber });
  if (entityType === 'WorkshopVisit') Object.assign(label, { repairOrderNo: record.repairOrderNo, vehicleId: record.vehicleId });
  if (entityType === 'MasterCallList') Object.assign(label, { vin: record.vin, customerName: record.customerName });
  if (entityType === 'Allocation') Object.assign(label, { vehicleId: record.vehicleId, creId: record.creId });
  if (entityType === 'VINConflictReview') Object.assign(label, { vin: record.vin, reason: record.reason });
  return label;
}

function changedBusinessFields(change) {
  return Object.keys(change.before || {}).filter((field) => field !== 'updatedAt'
    && !sameValue(change.before[field], change.after?.[field]));
}

function currentValueForField(record, field) {
  if (!Object.hasOwn(record, field)) return undefined;
  return record[field];
}

async function hasVerifiedPermanentDeletion(transaction, change, verificationByBatch) {
  if (change.batch?.status !== DELETION_MARKER) return false;
  const cached = verificationByBatch.get(change.importBatchId);
  if (cached !== undefined) return cached;

  const expectedAction = change.batch.importType === 'monthly_customer_data'
    ? 'MONTHLY_CUSTOMER_DATA_IMPORT_PERMANENTLY_DELETED'
    : 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED';
  const audit = await transaction.auditLog.findFirst({
    where: {
      entityType: 'ImportBatch',
      entityId: change.importBatchId,
      action: expectedAction,
    },
    select: { details: true },
  });
  let details = null;
  if (typeof audit?.details === 'string') {
    try {
      details = JSON.parse(audit.details);
    } catch {
      details = null;
    }
  }
  const loggedIds = details?.reversedChangeLogIds;
  let verified = details?.permanentDeletionEvidenceVersion === 1
    && details.importId === change.importBatchId
    && Array.isArray(loggedIds)
    && loggedIds.includes(change.id)
    && new Set(loggedIds).size === loggedIds.length;
  if (verified) {
    const persistedChanges = await transaction.importChangeLog.findMany({
      where: { importBatchId: change.importBatchId },
      select: { id: true },
    });
    const loggedIdSet = new Set(loggedIds);
    verified = persistedChanges.length === loggedIds.length
      && persistedChanges.every(({ id }) => loggedIdSet.has(id));
  }
  verificationByBatch.set(change.importBatchId, verified);
  return verified;
}

async function crossBatchEvidenceBlocker(transaction, change, completenessByBatch) {
  const batchStatus = change.batch?.status;
  const batchIsActive = ['completed', 'failed'].includes(batchStatus);
  const batchRollbackMetadataIsClear = change.batch?.rolledBackAt == null
    && change.batch?.rollbackError == null;
  const logIsPending = change.rollbackStatus === 'pending'
    && change.rolledBackAt == null
    && change.rollbackError == null;
  const snapshotIsComplete = importChangeLogIsComplete(change);
  let batchEvidenceComplete = completenessByBatch.get(change.importBatchId);
  if (batchEvidenceComplete === undefined) {
    batchEvidenceComplete = Boolean(change.batch?.rollbackSupported
      && await importRollbackCompleteness(transaction, change.importBatchId, change.batch.totalRows));
    completenessByBatch.set(change.importBatchId, batchEvidenceComplete);
  }
  if (batchIsActive
    && batchRollbackMetadataIsClear
    && logIsPending
    && snapshotIsComplete
    && batchEvidenceComplete) return null;
  const batchMetadataIssues = [
    change.batch?.rolledBackAt != null ? 'rolledBackAt is set' : null,
    change.batch?.rollbackError != null ? 'rollbackError is set' : null,
  ].filter(Boolean);
  return {
    code: 'cross-batch-reversal-unverified',
    entityType: change.entityType,
    entityId: change.entityId,
    importBatchId: change.importBatchId,
    changeLogId: change.id,
    operation: change.operation,
    batchStatus: batchStatus || null,
    rollbackStatus: change.rollbackStatus || null,
    message: batchMetadataIssues.length
      ? `Cross-batch change ${change.id} in import ${change.importBatchId} has contradictory batch rollback metadata (${batchMetadataIssues.join(', ')}); reversal cannot be independently verified.`
      : `Cross-batch change ${change.id} in import ${change.importBatchId} is invalidated, inconsistent, incomplete, or otherwise cannot be independently verified as active or reversed.`,
  };
}

function toDatabaseValue(field, value) {
  return dateFields.has(field) && value !== null ? new Date(value) : value;
}

function emptySummary() {
  return {
    directlyAffectedRecords: 0,
    dependentRecords: 0,
    totalRecordsDeleted: 0,
    laterImportBatchesAffected: 0,
    existingRecordsRestored: 0,
    existingRecordsRebased: 0,
    recordsPreserved: 0,
    physicalVehicleIdentitiesRetained: [],
    counts: {
      customers: 0,
      vehicles: 0,
      repairOrders: 0,
      callListRecords: 0,
      allocations: 0,
      calls: 0,
      appointments: 0,
      followUps: 0,
      ownershipRecords: 0,
      freeServiceMilestones: 0,
      appointmentEvents: 0,
      vinConflictReviews: 0,
      monthlyEntriesDetached: 0,
    },
  };
}

function buildPlanToken(plan) {
  const tokenSource = {
    batchId: plan.batch.id,
    batchStatus: plan.batch.status,
    batchCreatedAt: plan.batch.createdAt,
    fileName: plan.batch.fileName,
    batchEvidence: {
      rollbackSupported: plan.batch.rollbackSupported,
      totalRows: plan.batch.totalRows,
      allocationEvidenceState: plan.batch.allocationEvidenceState,
      allocationChangeCount: plan.batch.allocationChangeCount,
    },
    rowProgress: plan.batch.rowProgress,
    changes: plan.batch.changes,
    rebasedChanges: plan.rebasedChanges,
    deletionRecords: plan.deletionRecords,
    restoreRecords: plan.restoreRecords,
    currentRecords: plan.currentRecords,
    laterChanges: plan.laterChanges,
    dependencyFindings: plan.dependencyFindings,
    relatedBatchIds: plan.relatedBatchIds,
    laterImportBatchIds: plan.laterImportBatchIds,
    blockers: publicBlockers(plan.blockers),
  };
  return createHash('sha256').update(JSON.stringify(stableValue(tokenSource))).digest('hex');
}

function getIdsByType(records) {
  const byType = new Map(entityTypes.map((type) => [type, new Set()]));
  for (const record of records) byType.get(record.entityType)?.add(record.entityId);
  return byType;
}

async function findDependencies(transaction, targetBatch, targetCreatedRecords, scheduledDeletes) {
  const findings = [];
  const blockers = [];
  const idsByType = getIdsByType(targetCreatedRecords);
  const customerIds = [...idsByType.get('Customer')];
  const vehicleIds = [...idsByType.get('Vehicle')];
  const visitIds = [...idsByType.get('WorkshopVisit')];
  const customers = targetCreatedRecords.filter(({ entityType }) => entityType === 'Customer');
  const vehicles = targetCreatedRecords.filter(({ entityType }) => entityType === 'Vehicle');
  const visits = targetCreatedRecords.filter(({ entityType }) => entityType === 'WorkshopVisit');

  const checkReferences = async (parentType, parentIds, childType, delegate, where, relationField) => {
    if (!parentIds.length) return;
    const records = await transaction[delegate].findMany({
      where,
      select: { id: true, [relationField]: true },
    });
    for (const record of records) {
      const parentId = record[relationField];
      const finding = { parentType, parentId, childType, childId: record.id, relationField };
      findings.push(finding);
    }
  };

  await Promise.all([
    checkReferences('Customer', customerIds, 'Vehicle', 'vehicle', { customerId: { in: customerIds } }, 'customerId'),
    checkReferences('Customer', customerIds, 'WorkshopVisit', 'workshopVisit', { customerId: { in: customerIds } }, 'customerId'),
    checkReferences('Customer', customerIds, 'CallLog', 'callLog', { customerId: { in: customerIds } }, 'customerId'),
    checkReferences('Customer', customerIds, 'FollowUp', 'followUp', { customerId: { in: customerIds } }, 'customerId'),
    checkReferences('Customer', customerIds, 'Appointment', 'appointment', { customerId: { in: customerIds } }, 'customerId'),
    checkReferences('Customer', customerIds, 'MonthlyCustomerDataEntry', 'monthlyCustomerDataEntry', { customerId: { in: customerIds } }, 'customerId'),
    checkReferences('Vehicle', vehicleIds, 'WorkshopVisit', 'workshopVisit', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'Allocation', 'allocation', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'CallLog', 'callLog', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'FollowUp', 'followUp', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'Appointment', 'appointment', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'VehicleOwnershipHistory', 'vehicleOwnershipHistory', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'MonthlyCustomerDataEntry', 'monthlyCustomerDataEntry', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
    checkReferences('Vehicle', vehicleIds, 'FreeServiceMilestone', 'freeServiceMilestone', { vehicleId: { in: vehicleIds } }, 'vehicleId'),
  ]);

  const vehicleScopes = vehicles
    .filter(({ record }) => record?.vin && record?.ccmId)
    .map(({ entityId, record }) => ({ entityId, vin: record.vin, ccmId: record.ccmId }));
  if (vehicleScopes.length) {
    const [callListRows, reviewRows] = await Promise.all([
      transaction.masterCallList.findMany({
        where: {
          OR: [
            { vehicleId: { in: vehicleScopes.map(({ entityId }) => entityId) } },
            ...vehicleScopes.map(({ vin, ccmId }) => ({ vin, ccmId })),
          ],
        },
        select: { id: true, vin: true, ccmId: true, vehicleId: true },
      }),
      transaction.vINConflictReview.findMany({
        where: {
          OR: vehicleScopes.map(({ vin, ccmId }) => ({
            vin,
            OR: [{ sourceCcmId: ccmId }, { targetCcmId: ccmId }],
          })),
        },
        select: { id: true, vin: true },
      }),
    ]);
    for (const [childType, records] of [['MasterCallList', callListRows], ['VINConflictReview', reviewRows]]) {
      for (const record of records) {
        const parent = vehicleScopes.find(({ entityId, vin, ccmId }) => (
          childType === 'MasterCallList'
            ? record.vehicleId === entityId || (record.vin === vin && record.ccmId === ccmId)
            : record.vin === vin
        ));
        const finding = {
          parentType: 'Vehicle',
          parentId: parent?.entityId || null,
          childType,
          childId: record.id,
          relationField: 'vin',
        };
        findings.push(finding);
      }
    }
  }

  const visitRecords = visits.filter(({ record }) => record?.vehicleId && record?.repairOrderNo);
  const visitIdentityRows = visitRecords.length
    ? await transaction.workshopVisit.findMany({
      where: { id: { in: visitRecords.map(({ entityId }) => entityId) } },
      select: { id: true, physicalVehicleId: true },
    })
    : [];
  const physicalVehicleIdByVisit = new Map(visitIdentityRows.map(({ id, physicalVehicleId }) => [id, physicalVehicleId]));
  const physicalVehicleIdsForVisits = [...new Set(visitIdentityRows.map(({ physicalVehicleId }) => physicalVehicleId))];
  if (physicalVehicleIdsForVisits.length) {
    const milestones = await transaction.freeServiceMilestone.findMany({
      where: { physicalVehicleId: { in: physicalVehicleIdsForVisits } },
      select: {
        id: true,
        vehicleId: true,
        physicalVehicleId: true,
        completedByRepairOrderNo: true,
        completedByWorkshopVisitId: true,
      },
    });
    for (const milestone of milestones.filter(({ completedByWorkshopVisitId, completedByRepairOrderNo }) => (
      completedByWorkshopVisitId != null || completedByRepairOrderNo != null
    ))) {
      const linkedVisits = visitRecords.filter(({ entityId, record }) => (
        milestone.completedByWorkshopVisitId === entityId
        || (milestone.completedByWorkshopVisitId == null
          && physicalVehicleIdByVisit.get(entityId) === milestone.physicalVehicleId
          && normalizeRepairOrderNo(record.repairOrderNo) === normalizeRepairOrderNo(milestone.completedByRepairOrderNo))
      ));
      for (const visit of linkedVisits) {
        findings.push({
          parentType: 'WorkshopVisit',
          parentId: visit.entityId,
          childType: 'FreeServiceMilestone',
          childId: milestone.id,
          relationField: milestone.completedByWorkshopVisitId
            ? 'completedByWorkshopVisitId'
            : 'completedByRepairOrderNo',
        });
      }
    }
  }

  const dependencyEntities = [...new Map(findings.map(({ childType, childId }) => [
    `${childType}:${childId}`,
    { entityType: childType, entityId: childId },
  ])).values()];
  const dependencyLogs = dependencyEntities.length
    ? await transaction.importChangeLog.findMany({
      where: {
        OR: dependencyEntities.map(({ entityType, entityId }) => ({ entityType, entityId })),
      },
      include: { batch: { select: {
        id: true,
        fileName: true,
        importType: true,
        status: true,
        createdAt: true,
        totalRows: true,
        rollbackSupported: true,
        rolledBackAt: true,
        rollbackError: true,
      } } },
    })
    : [];
  const dependencyLogsByEntity = new Map();
  const relatedBatchIds = new Set();
  const laterImportBatchIds = new Set();
  const dependencyBatchEvidence = new Map();
  const permanentlyDeletedBatchEvidence = new Map();
  for (const change of dependencyLogs) {
    if (change.importBatchId === targetBatch.id) continue;
    if (await hasVerifiedPermanentDeletion(transaction, change, permanentlyDeletedBatchEvidence)) continue;
    const invalidEvidence = await crossBatchEvidenceBlocker(transaction, change, dependencyBatchEvidence);
    if (invalidEvidence) {
      addBlocker(blockers, invalidEvidence);
      continue;
    }
    relatedBatchIds.add(change.importBatchId);
    const key = `${change.entityType}:${change.entityId}`;
    const entries = dependencyLogsByEntity.get(key) || [];
    entries.push(change);
    dependencyLogsByEntity.set(key, entries);
  }
  for (const finding of findings) {
    if (scheduledDeletes.get(finding.childType)?.has(finding.childId)) {
      finding.disposition = 'deleted_with_target_import';
      finding.blocked = false;
      continue;
    }
    const importLog = dependencyLogsByEntity.get(`${finding.childType}:${finding.childId}`)?.[0];
    const isLaterImport = importLog?.batch?.createdAt
      && new Date(importLog.batch.createdAt) >= new Date(targetBatch.createdAt);
    finding.disposition = isLaterImport ? 'later_import_reference' : 'crm_workflow_reference';
    finding.importBatchId = importLog?.importBatchId || null;
    finding.blocked = true;
    if (isLaterImport) laterImportBatchIds.add(importLog.importBatchId);
    addBlocker(blockers, {
      code: isLaterImport ? 'later-import-dependency' : 'crm-workflow-reference',
      entityType: finding.parentType,
      entityId: finding.parentId,
      relatedEntityType: finding.childType,
      relatedEntityId: finding.childId,
      importBatchId: importLog?.importBatchId || null,
      message: isLaterImport
        ? `A record from later import ${importLog.importBatchId} still references this ${finding.parentType}.`
        : finding.childType === 'FreeServiceMilestone'
          ? 'A free-service milestone records this repair order as completed; it will not be changed automatically.'
          : `A ${finding.childType} record still references this ${finding.parentType}; it will not be deleted automatically.`,
    });
  }

  return {
    findings,
    blockers,
    relatedBatchIds: [...relatedBatchIds],
    laterImportBatchIds: [...laterImportBatchIds],
  };
}

async function loadDeletionPlan(transaction, importBatchId) {
  const batch = await transaction.importBatch.findUnique({
    where: { id: importBatchId },
    include: {
      changes: { orderBy: [{ sequence: 'asc' }, { id: 'asc' }] },
      rowProgress: {
        orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
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
      blockers: [],
      deletionRecords: [],
      restoreRecords: [],
      currentRecords: [],
      laterChanges: [],
      dependencyFindings: [],
      relatedBatchIds: [],
      laterImportBatchIds: [],
      summary: emptySummary(),
    };
  }
  if (!['completed', 'failed'].includes(batch.status)) {
    throw new PermanentImportDeletionConflict('Only completed or failed imports can be permanently deleted.');
  }

  const blockers = [];
  if (batch.rolledBackAt != null || batch.rollbackError != null) {
    const metadataIssues = [
      batch.rolledBackAt != null ? 'rolledBackAt is set' : null,
      batch.rollbackError != null ? 'rollbackError is set' : null,
    ].filter(Boolean);
    addBlocker(blockers, {
      code: 'target-batch-rollback-metadata-unverified',
      importBatchId: batch.id,
      changeLogId: batch.changes[0]?.id || null,
      message: `Target import ${batch.id} has contradictory batch rollback metadata (${metadataIssues.join(', ')}); its changes cannot authorize deletion or restoration.`,
    });
  }
  const genuinelyEmpty = batch.totalRows === 0
    && batch.processingStartedAt != null
    && batch.statsComplete
    && batch.rowProgress.length === 0
    && batch.changes.length === 0
    && ['createdRows', 'appendedRows', 'affectedCustomers', 'affectedVehicles', 'affectedRepairOrders',
      'affectedCallListEntries', 'affectedAllocations', 'affectedMonthlyEntries']
      .every((field) => (batch[field] || 0) === 0);
  const evidenceComplete = genuinelyEmpty || (batch.rollbackSupported
    && await importRollbackCompleteness(transaction, batch.id, batch.totalRows));
  if (!evidenceComplete) {
    addBlocker(blockers, {
      code: 'incomplete-import-evidence',
      message: 'The import does not have complete verified row progress and change snapshots. Its mutations cannot be safely reversed.',
    });
  }

  const validChanges = [];
  for (const change of batch.changes) {
    const metadataIssues = [
      change.rolledBackAt != null ? 'rolledBackAt is set' : null,
      change.rollbackError != null ? 'rollbackError is set' : null,
    ].filter(Boolean);
    if (change.rollbackStatus !== 'pending' || metadataIssues.length) {
      addBlocker(blockers, {
        code: 'invalid-target-change-rollback-metadata',
        entityType: change.entityType,
        entityId: change.entityId,
        importBatchId: batch.id,
        changeLogId: change.id,
        message: `Target change ${change.id} in import ${batch.id} is not admissible for reversal (${[
          change.rollbackStatus !== 'pending' ? `rollbackStatus is ${change.rollbackStatus}` : null,
          ...metadataIssues,
        ].filter(Boolean).join(', ')}).`,
      });
      continue;
    }
    if (change.importBatchId !== batch.id
      || !entityConfig[change.entityType]
      || !importChangeLogIsComplete(change)) {
      addBlocker(blockers, {
        code: 'invalid-change-log',
        entityType: change.entityType || null,
        entityId: change.entityId || null,
        message: `Change ${change.id || '(unknown)'} has unsupported or incomplete mutation evidence.`,
      });
      continue;
    }
    validChanges.push(change);
  }

  const grouped = new Map();
  for (const change of sortedChanges(validChanges)) {
    const key = `${change.entityType}:${change.entityId}`;
    if (!grouped.has(key)) grouped.set(key, { entityType: change.entityType, entityId: change.entityId, changes: [] });
    grouped.get(key).changes.push(change);
  }

  const deletionRecords = [];
  const restoreRecords = [];
  const rebasedChanges = new Map();
  const currentRecords = [];
  const targetCreatedRecords = [];
  const scheduledDeletes = new Map(entityTypes.map((type) => [type, new Set()]));
  const existingUpdateGroups = [];

  for (const group of grouped.values()) {
    const { entityType, entityId, changes } = group;
    const creates = changes.filter(({ operation }) => operation === 'CREATE');
    if (creates.length > 1 || (creates.length && changes[0].operation !== 'CREATE')) {
      addBlocker(blockers, {
        code: 'inconsistent-entity-history',
        entityType,
        entityId,
        message: `The change history for ${entityType} ${entityId} has an invalid CREATE/UPDATE order.`,
      });
      continue;
    }
    const delegate = entityConfig[entityType].delegate;
    const record = await transaction[delegate].findUnique({ where: { id: entityId } });
    if (!record) {
      addBlocker(blockers, {
        code: 'target-entity-missing',
        entityType,
        entityId,
        message: `The ${entityType} ${entityId} recorded by this import no longer exists.`,
      });
      continue;
    }
    currentRecords.push({ entityType, entityId, record: stableValue(record) });

    if (creates.length) {
      const createChange = creates[0];
      const expected = structuredClone(createChange.after);
      let historyConsistent = true;
      for (const change of changes.slice(1)) {
        if (change.operation !== 'UPDATE') {
          historyConsistent = false;
          break;
        }
        for (const field of Object.keys(change.before)) {
          if (!Object.hasOwn(expected, field) || !sameValue(expected[field], change.before[field])) {
            historyConsistent = false;
            break;
          }
        }
        if (!historyConsistent) break;
        Object.assign(expected, change.after);
      }
      if (!historyConsistent) {
        addBlocker(blockers, {
          code: 'inconsistent-entity-history',
          entityType,
          entityId,
          message: `The recorded changes for ${entityType} ${entityId} do not form a consistent state history.`,
        });
      }
      if (!recordMatchesExpected(entityType, record, expected)) {
        addBlocker(blockers, {
          code: 'snapshot-mismatch',
          entityType,
          entityId,
          message: `The current ${entityType} ${entityId} no longer matches the state recorded for this import.`,
        });
      }
      const deletionRecord = {
        entityType,
        entityId,
        sequence: createChange.sequence,
        record: recordLabel(entityType, expected),
        expectedState: expected,
      };
      deletionRecords.push(deletionRecord);
      targetCreatedRecords.push({ entityType, entityId, record: expected });
      scheduledDeletes.get(entityType).add(entityId);
    } else {
      existingUpdateGroups.push(group);
    }
  }

  const updateEntityOr = existingUpdateGroups.map(({ entityType, entityId }) => ({
    entityType,
    entityId,
  }));
  const relatedLogs = updateEntityOr.length
    ? await transaction.importChangeLog.findMany({
      where: {
        OR: updateEntityOr.map(({ entityType, entityId }) => ({ entityType, entityId })),
      },
      include: { batch: { select: {
        id: true,
        fileName: true,
        importType: true,
        status: true,
        createdAt: true,
        totalRows: true,
        rollbackSupported: true,
        rolledBackAt: true,
        rollbackError: true,
      } } },
    })
    : [];
  const createEntityOr = targetCreatedRecords.map(({ entityType, entityId }) => ({ entityType, entityId }));
  const createdEntityLogs = createEntityOr.length
    ? await transaction.importChangeLog.findMany({
      where: { OR: createEntityOr.map(({ entityType, entityId }) => ({ entityType, entityId })) },
      include: { batch: { select: {
        id: true,
        fileName: true,
        importType: true,
        status: true,
        createdAt: true,
        totalRows: true,
        rollbackSupported: true,
        rolledBackAt: true,
        rollbackError: true,
      } } },
    })
    : [];
  const allRelevantLogs = [...relatedLogs, ...createdEntityLogs];
  const importByEntity = new Map();
  const laterChanges = [];
  const relatedBatchIds = new Set();
  const crossBatchEvidence = new Map();
  const permanentlyDeletedEvidence = new Map();
  for (const change of allRelevantLogs) {
    if (change.importBatchId === batch.id) continue;
    if (await hasVerifiedPermanentDeletion(transaction, change, permanentlyDeletedEvidence)) continue;
    const invalidEvidence = await crossBatchEvidenceBlocker(transaction, change, crossBatchEvidence);
    if (invalidEvidence) {
      addBlocker(blockers, invalidEvidence);
      continue;
    }
    relatedBatchIds.add(change.importBatchId);
    const key = `${change.entityType}:${change.entityId}`;
    const entries = importByEntity.get(key) || [];
    entries.push(change);
    importByEntity.set(key, entries);
    if (change.batch?.createdAt && new Date(change.batch.createdAt) < new Date(batch.createdAt)) continue;
    laterChanges.push(change);
  }
  for (const entries of importByEntity.values()) {
    entries.sort((left, right) => new Date(left.batch?.createdAt || 0) - new Date(right.batch?.createdAt || 0)
      || left.sequence - right.sequence);
  }

  for (const created of targetCreatedRecords) {
    const otherBatchLogs = (importByEntity.get(`${created.entityType}:${created.entityId}`) || [])
      .filter(({ importBatchId }) => importBatchId !== batch.id);
    for (const change of otherBatchLogs) {
      addBlocker(blockers, {
        code: 'later-import-modification',
        entityType: created.entityType,
        entityId: created.entityId,
        importBatchId: change.importBatchId,
        message: `Import ${change.importBatchId} also changed ${created.entityType} ${created.entityId}; deletion would invalidate that import's history.`,
      });
    }
  }

  for (const group of existingUpdateGroups) {
    const { entityType, entityId, changes } = group;
    const record = currentRecords.find((entry) => entry.entityType === entityType && entry.entityId === entityId)?.record;
    if (!record) continue;
    const targetFields = new Set(changes.flatMap(changedBusinessFields));
    const logs = (importByEntity.get(`${entityType}:${entityId}`) || [])
      .filter(({ importBatchId }) => importBatchId !== batch.id);
    const activeLaterLogs = logs.filter((change) => (
      change.batch?.createdAt && new Date(change.batch.createdAt) >= new Date(batch.createdAt)
    ));
    const orderedLaterLogs = [...activeLaterLogs].sort((left, right) => (
      new Date(left.batch.createdAt) - new Date(right.batch.createdAt)
      || new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
      || left.sequence - right.sequence
      || left.id.localeCompare(right.id)
    ));
    let historyConsistent = true;
    let expectedUpdatedAt = sortedChanges(changes).at(-1)?.after?.updatedAt;
    for (const change of orderedLaterLogs) {
      if (change.operation !== 'UPDATE' || !importChangeLogIsComplete(change)) {
        addBlocker(blockers, {
          code: 'later-import-evidence-incomplete',
          entityType,
          entityId,
          importBatchId: change.importBatchId,
          message: `Import ${change.importBatchId} has unsupported or incomplete changes for ${entityType} ${entityId}; the field history cannot be verified.`,
        });
        continue;
      }
      if (expectedUpdatedAt && !sameValue(expectedUpdatedAt, change.before.updatedAt)) {
        historyConsistent = false;
      }
      expectedUpdatedAt = change.after.updatedAt;
    }
    for (const change of activeLaterLogs) {
      if (!importChangeLogIsComplete(change)) {
        addBlocker(blockers, {
          code: 'later-import-evidence-incomplete',
          entityType,
          entityId,
          importBatchId: change.importBatchId,
          message: `Import ${change.importBatchId} has incomplete changes for ${entityType} ${entityId}; the field history cannot be verified.`,
        });
        continue;
      }
    }

    const expectedCurrent = new Map();
    const originalValues = new Map();
    const orderedTargetChanges = sortedChanges(changes);
    for (const [index, change] of orderedTargetChanges.entries()) {
      if (index && !sameValue(orderedTargetChanges[index - 1].after.updatedAt, change.before.updatedAt)) {
        historyConsistent = false;
      }
      for (const field of changedBusinessFields(change)) {
        if (expectedCurrent.has(field) && !sameValue(expectedCurrent.get(field), change.before[field])) {
          historyConsistent = false;
        }
        if (!originalValues.has(field)) originalValues.set(field, change.before[field]);
        expectedCurrent.set(field, change.after[field]);
      }
    }
    for (const field of targetFields) {
      if (!activeLaterLogs.some((change) => changedBusinessFields(change).includes(field))) continue;
      const firstLaterChange = orderedLaterLogs.find((change) => changedBusinessFields(change).includes(field));
      if (!firstLaterChange || !originalValues.has(field)) continue;
      const rebased = rebasedChanges.get(firstLaterChange.id) || {
        id: firstLaterChange.id,
        importBatchId: firstLaterChange.importBatchId,
        entityType,
        entityId,
        before: structuredClone(firstLaterChange.before),
      };
      rebased.before[field] = originalValues.get(field);
      rebasedChanges.set(firstLaterChange.id, rebased);
    }
    if (orderedLaterLogs.length && changes[0]?.before && Object.hasOwn(changes[0].before, 'updatedAt')) {
      const firstLaterChange = orderedLaterLogs[0];
      const rebased = rebasedChanges.get(firstLaterChange.id) || {
        id: firstLaterChange.id,
        importBatchId: firstLaterChange.importBatchId,
        entityType,
        entityId,
        before: structuredClone(firstLaterChange.before),
      };
      rebased.before.updatedAt = changes[0].before.updatedAt;
      rebasedChanges.set(firstLaterChange.id, rebased);
    }
    const laterExpected = new Map(expectedCurrent);
    for (const change of orderedLaterLogs) {
      if (!importChangeLogIsComplete(change)) continue;
      for (const field of changedBusinessFields(change)) {
        if (laterExpected.has(field) && !sameValue(laterExpected.get(field), change.before[field])) {
          historyConsistent = false;
        }
        laterExpected.set(field, change.after[field]);
      }
    }
    if (!historyConsistent) {
      addBlocker(blockers, {
        code: 'inconsistent-update-history',
        entityType,
        entityId,
        message: `The recorded updates for ${entityType} ${entityId} do not form a consistent field history.`,
      });
    }

    const latestActiveLog = orderedLaterLogs.filter(({ operation }) => operation === 'UPDATE').at(-1);
    for (const [field, expected] of laterExpected) {
      if (!sameValue(currentValueForField(record, field), expected)) {
        addBlocker(blockers, {
          code: 'snapshot-mismatch',
          entityType,
          entityId,
          field,
          message: `The current value of ${entityType} ${entityId}.${field} differs from the verified import history.`,
        });
      }
    }
    const finalTargetUpdate = sortedChanges(changes).at(-1);
    const targetUpdatedAt = finalTargetUpdate?.after?.updatedAt;
    if (targetUpdatedAt && latestActiveLog?.after?.updatedAt) {
      if (!sameValue(record.updatedAt, latestActiveLog.after.updatedAt)) {
        addBlocker(blockers, {
          code: 'snapshot-mismatch',
          entityType,
          entityId,
          field: 'updatedAt',
          message: `The current timestamp for ${entityType} ${entityId} does not match the later import history.`,
        });
      }
    } else if (targetUpdatedAt && !sameValue(record.updatedAt, targetUpdatedAt)) {
      addBlocker(blockers, {
        code: 'snapshot-mismatch',
        entityType,
        entityId,
        field: 'updatedAt',
        message: `The current timestamp for ${entityType} ${entityId} changed without verifiable later import history.`,
      });
    }

    const rebasedFields = new Set([...targetFields].filter((field) => (
      orderedLaterLogs.some((change) => changedBusinessFields(change).includes(field))
    )));
    const restoreFields = Object.fromEntries([...originalValues]
      .filter(([field]) => !rebasedFields.has(field))
      .map(([field, value]) => [field, value]));
    if (!activeLaterLogs.length && changes[0]?.before && Object.hasOwn(changes[0].before, 'updatedAt')) {
      restoreFields.updatedAt = changes[0].before.updatedAt;
    }
    const restorationSteps = sortedChanges(changes).reverse().map((change) => ({
      sequence: change.sequence,
      fields: Object.fromEntries(changedBusinessFields(change)
        .filter((field) => !rebasedFields.has(field))
        .map((field) => [field, change.before[field]])),
    })).filter(({ fields }) => Object.keys(fields).length);
    if (Object.keys(restoreFields).length) {
      restoreRecords.push({
        entityType,
        entityId,
        record: recordLabel(entityType, record),
        fields: Object.fromEntries(Object.entries(restoreFields).map(([field, before]) => [
          field,
          { before, current: currentValueForField(record, field) },
        ])),
        restorationSteps,
        updatedAtRestore: Object.hasOwn(restoreFields, 'updatedAt') ? restoreFields.updatedAt : null,
        updatedAtPreserve: activeLaterLogs.length ? currentValueForField(record, 'updatedAt') : null,
      });
    }
  }

  const dependencies = await findDependencies(transaction, batch, targetCreatedRecords, scheduledDeletes);
  for (const blocker of dependencies.blockers) addBlocker(blockers, blocker);
  for (const id of dependencies.relatedBatchIds) relatedBatchIds.add(id);
  const laterImportBatchIds = new Set([
    ...laterChanges.map(({ importBatchId }) => importBatchId),
    ...dependencies.laterImportBatchIds,
  ]);
  laterChanges.sort((left, right) => new Date(left.batch?.createdAt || 0) - new Date(right.batch?.createdAt || 0)
    || left.sequence - right.sequence
    || left.id.localeCompare(right.id));

  const orderedDeletionRecords = [...deletionRecords].sort((left, right) => (
    right.sequence - left.sequence || left.entityId.localeCompare(right.entityId)
  ));
  const counts = {
    customers: deletionRecords.filter(({ entityType }) => entityType === 'Customer').length,
    vehicles: deletionRecords.filter(({ entityType }) => entityType === 'Vehicle').length,
    repairOrders: deletionRecords.filter(({ entityType }) => entityType === 'WorkshopVisit').length,
    callListRecords: deletionRecords.filter(({ entityType }) => entityType === 'MasterCallList').length,
    allocations: deletionRecords.filter(({ entityType }) => entityType === 'Allocation').length,
    calls: 0,
    appointments: 0,
    followUps: 0,
    ownershipRecords: 0,
    freeServiceMilestones: 0,
    appointmentEvents: 0,
    vinConflictReviews: deletionRecords.filter(({ entityType }) => entityType === 'VINConflictReview').length,
    monthlyEntriesDetached: deletionRecords.filter(({ entityType }) => entityType === 'MonthlyCustomerDataEntry').length,
  };
  const directlyAffectedRecords = deletionRecords.length;
  const relatedVehicleIds = [...new Set(currentRecords
    .map(({ record }) => record.vehicleId)
    .filter(Boolean))];
  const relatedVehicles = relatedVehicleIds.length
    ? await transaction.vehicle.findMany({
      where: { id: { in: relatedVehicleIds } },
      select: { physicalVehicleId: true },
    })
    : [];
  const physicalVehicleIdsRetained = [...new Set([
    ...currentRecords.map(({ record }) => record.physicalVehicleId),
    ...relatedVehicles.map(({ physicalVehicleId }) => physicalVehicleId),
  ].filter(Boolean))].sort();
  const retainedPhysicalVehicles = physicalVehicleIdsRetained.length
    ? await transaction.physicalVehicle.findMany({
      where: { id: { in: physicalVehicleIdsRetained } },
      select: { id: true, vin: true },
    })
    : [];
  const physicalVehicleById = new Map(retainedPhysicalVehicles.map(({ id, vin }) => [id, vin]));
  const physicalVehicleIdentitiesRetained = physicalVehicleIdsRetained.map((id) => ({
    id,
    vin: physicalVehicleById.get(id) || null,
  }));
  const summary = {
    directlyAffectedRecords,
    dependentRecords: 0,
    totalRecordsDeleted: deletionRecords.length,
    laterImportBatchesAffected: laterImportBatchIds.size,
    existingRecordsRestored: restoreRecords.length,
    existingRecordsRebased: new Set([...rebasedChanges.values()]
      .map(({ entityType, entityId }) => `${entityType}:${entityId}`)).size,
    recordsPreserved: Math.max(0, currentRecords.length - deletionRecords.length),
    physicalVehicleIdentitiesRetained,
    counts,
  };
  return {
    batch,
    alreadyDeleted: false,
    blockers,
    deletionRecords: orderedDeletionRecords,
    restoreRecords,
    currentRecords,
    laterChanges,
    rebasedChanges: [...rebasedChanges.values()],
    dependencyFindings: [...dependencies.findings].sort((left, right) => (
      `${left.parentType}:${left.parentId}:${left.childType}:${left.childId}:${left.relationField}`
        .localeCompare(`${right.parentType}:${right.parentId}:${right.childType}:${right.childId}:${right.relationField}`)
    )),
    relatedBatchIds: [...relatedBatchIds].sort(),
    laterImportBatchIds: [...laterImportBatchIds].sort(),
    summary,
  };
}

function toPreview(plan) {
  const blockers = publicBlockers(plan.blockers);
  const deletionBlocked = blockers.length > 0;
  const willDelete = plan.deletionRecords.map(({ entityType, entityId, record }) => ({
    entityType,
    entityId,
    record,
  }));
  const willRestore = plan.restoreRecords.map(({ entityType, entityId, record, fields }) => ({
    entityType,
    entityId,
    record,
    fields,
  }));
  return {
    importId: plan.batch.id,
    fileName: plan.batch.fileName,
    importedAt: plan.batch.createdAt,
    status: plan.batch.status,
    alreadyDeleted: plan.alreadyDeleted,
    confirmationToken: plan.alreadyDeleted || deletionBlocked ? null : buildPlanToken(plan),
    deletionBlocked,
    blockers,
    willDelete,
    willRestore,
    dependencies: plan.dependencyFindings,
    affectedImportBatches: [],
    restoredRecords: willRestore.map(({ entityType, entityId }) => ({ entityType, entityId })),
    recordsAlreadyAbsent: [],
    ...plan.summary,
  };
}

export async function previewPermanentImportDeletion(importBatchId, database = prisma) {
  return database.$transaction(async (transaction) => {
    const plan = await loadDeletionPlan(transaction, importBatchId);
    return toPreview(plan);
  }, { isolationLevel: 'RepeatableRead' });
}

async function lockPlanRecords(transaction, plan) {
  const lockRecords = new Map();
  for (const record of plan.currentRecords) {
    const config = entityConfig[record.entityType];
    if (config) lockRecords.set(`${config.table}:${record.entityId}`, { ...config, id: record.entityId });
  }
  for (const [, record] of [...lockRecords].sort(([left], [right]) => left.localeCompare(right))) {
    await transaction.$queryRawUnsafe(
      `SELECT "id" FROM "${record.table}" WHERE "id" = $1 FOR UPDATE`,
      record.id,
    );
  }
}

async function lockPlanBatches(transaction, plan) {
  const batchIds = [...new Set([plan.batch.id, ...plan.relatedBatchIds])].sort();
  for (const id of batchIds) {
    await transaction.$queryRawUnsafe(
      'SELECT "id" FROM "import_batches" WHERE "id" = $1 FOR UPDATE',
      id,
    );
  }
}

export async function permanentlyDeleteImportBatch(importBatchId, adminId, confirmationToken, database = prisma) {
  if (!confirmationToken) {
    throw new PermanentImportDeletionConflict('Refresh the permanent-deletion preview and confirm again.');
  }
  return database.$transaction(async (transaction) => {
    let plan = await loadDeletionPlan(transaction, importBatchId);
    if (plan.alreadyDeleted) return { status: DELETION_MARKER, alreadyDeleted: true, summary: emptySummary() };
    if (plan.blockers.length) {
      throw new PermanentImportDeletionConflict('Permanent deletion is blocked because one or more changes cannot be safely reversed.', publicBlockers(plan.blockers));
    }

    await lockPlanBatches(transaction, plan);
    plan = await loadDeletionPlan(transaction, importBatchId);
    if (plan.blockers.length) {
      throw new PermanentImportDeletionConflict('Permanent deletion is blocked because the data changed or a dependency was found.', publicBlockers(plan.blockers));
    }

    await lockPlanRecords(transaction, plan);
    plan = await loadDeletionPlan(transaction, importBatchId);
    if (plan.blockers.length) {
      throw new PermanentImportDeletionConflict('Permanent deletion is blocked because the data changed or a dependency was found.', publicBlockers(plan.blockers));
    }
    if (buildPlanToken(plan) !== confirmationToken) {
      throw new PermanentImportDeletionConflict('The deletion plan changed after preview. Refresh the preview and review it again.');
    }

    const restorationSteps = plan.restoreRecords.flatMap((restore) => restore.restorationSteps.map((step) => ({
      ...step,
      entityType: restore.entityType,
      entityId: restore.entityId,
    }))).sort((left, right) => right.sequence - left.sequence);
    for (const step of restorationSteps) {
      const data = Object.fromEntries(Object.entries(step.fields)
        .map(([field, value]) => [field, toDatabaseValue(field, value)]));
      if (Object.keys(data).length) {
        await transaction[entityConfig[step.entityType].delegate].update({
          where: { id: step.entityId },
          data,
        });
      }
    }
    for (const change of plan.rebasedChanges) {
      await transaction.importChangeLog.update({
        where: { id: change.id },
        data: { before: change.before },
      });
    }
    for (const restore of plan.restoreRecords) {
      const updatedAt = restore.updatedAtRestore || restore.updatedAtPreserve;
      if (updatedAt) {
        await transaction[entityConfig[restore.entityType].delegate].update({
          where: { id: restore.entityId },
          data: { updatedAt: toDatabaseValue('updatedAt', updatedAt) },
        });
      }
    }

    for (const record of plan.deletionRecords) {
      const result = await transaction[entityConfig[record.entityType].delegate].deleteMany({
        where: { id: record.entityId },
      });
      if (result.count !== 1) {
        throw new PermanentImportDeletionConflict(`The ${record.entityType} ${record.entityId} changed while deletion was in progress.`);
      }
    }

    const now = new Date();
    const updatedBatch = await transaction.importBatch.update({
      where: { id: plan.batch.id },
      data: {
        status: DELETION_MARKER,
        rollbackSupported: false,
        rolledBackAt: now,
        rollbackError: `Permanently deleted by Admin ${adminId}.`,
      },
    });
    if (plan.batch.importType === 'monthly_customer_data') {
      await transaction.monthlyCustomerDataImport.updateMany({
        where: { importBatchId: plan.batch.id },
        data: { status: DELETION_MARKER },
      });
    }
    await transaction.auditLog.create({
      data: {
        userId: adminId,
        entityType: 'ImportBatch',
        entityId: plan.batch.id,
        action: plan.batch.importType === 'monthly_customer_data'
          ? 'MONTHLY_CUSTOMER_DATA_IMPORT_PERMANENTLY_DELETED'
          : 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED',
        details: JSON.stringify({
          permanentDeletionEvidenceVersion: 1,
          importId: plan.batch.id,
          fileName: plan.batch.fileName,
          deletedAt: now.toISOString(),
          reversedChangeLogIds: plan.batch.changes.map(({ id }) => id),
          deletedRecords: plan.deletionRecords.map(({ entityType, entityId }) => ({ entityType, entityId })),
          restoredRecords: plan.restoreRecords.map(({ entityType, entityId, fields }) => ({
            entityType,
            entityId,
            fields: Object.keys(fields),
          })),
          rebasedChanges: plan.rebasedChanges.map(({ id, entityType, entityId }) => ({
            changeLogId: id,
            entityType,
            entityId,
          })),
          physicalVehicleIdentitiesRetained: plan.summary.physicalVehicleIdentitiesRetained,
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
