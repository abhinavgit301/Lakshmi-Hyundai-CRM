import { createHash } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { importBatchMutationEvidenceIsComplete, importChangeLogIsComplete } from '../utils/importBatchStats.js';
import { normalizeRepairOrderNo } from '../utils/repairOrderIdentity.js';

const DELETED = 'permanently_deleted';
const entities = {
  Customer: { delegate: 'customer', table: 'customers' },
  Vehicle: { delegate: 'vehicle', table: 'vehicles' },
  WorkshopVisit: { delegate: 'workshopVisit', table: 'workshop_visits' },
  MasterCallList: { delegate: 'masterCallList', table: 'master_call_lists' },
  Allocation: { delegate: 'allocation', table: 'allocations' },
  VINConflictReview: { delegate: 'vINConflictReview', table: 'vin_conflict_reviews' },
};
const dateFields = new Set(['createdAt', 'updatedAt', 'saleDate', 'visitDate', 'closingDate', 'gpDate']);

export class LegacyImportReconciliationConflict extends Error {
  constructor(message, blockers = []) {
    super(message);
    this.name = 'LegacyImportReconciliationConflict';
    this.blockers = blockers;
  }
}

function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return stable(value.toJSON());
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function publicBlockers(blockers) {
  const keyed = new Map(blockers.map((blocker) => [
    `${blocker.code}:${blocker.entityType || ''}:${blocker.entityId || ''}:${blocker.relatedEntityId || ''}`,
    blocker,
  ]));
  return [...keyed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, blocker]) => blocker);
}

function isLegacyCandidateBatch(batch, changes) {
  return batch.status === DELETED
    || batch.status === 'rolled_back'
    || !batch.processingStartedAt
    || !batch.rollbackSupported
    || (['completed', 'failed'].includes(batch.status)
      && changes.some(({ rollbackStatus }) => rollbackStatus === DELETED));
}

function mutationEvidenceIsComplete(batch, changes, rows) {
  return importBatchMutationEvidenceIsComplete({
    id: batch.id,
    totalRows: batch.totalRows,
    rowProgress: rows,
    changes,
    allocationEvidenceState: batch.allocationEvidenceState,
    allocationChangeCount: batch.allocationChangeCount,
  });
}

function observedFieldsMatch(record, snapshot) {
  return Object.entries(snapshot || {}).every(([field, value]) => equal(record?.[field], value));
}

function applyChanges(changes) {
  const ordered = [...changes].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const create = ordered.find(({ operation }) => operation === 'CREATE');
  if (!create || !importChangeLogIsComplete(create)) return null;
  const state = structuredClone(create.after);
  let valid = ordered[0] === create;
  for (const change of ordered.slice(1)) {
    if (change.operation !== 'UPDATE' || !importChangeLogIsComplete(change)
      || !observedFieldsMatch(state, change.before)) {
      valid = false;
      break;
    }
    Object.assign(state, change.after);
  }
  return valid ? state : null;
}

function recordLabel(type, record) {
  return { id: record.id, entityType: type };
}

function safeCurrentState(record) {
  const fields = ['id', 'ccmId', 'status', 'customerId', 'vehicleId', 'repairOrderNo', 'createdAt', 'updatedAt'];
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field))
    .map((field) => [field, stable(record[field])]));
}

async function findDependencies(transaction, type, record) {
  const dependencies = [];
  const add = (kind, rows) => rows.forEach(({ id }) => dependencies.push({ kind, id }));
  if (type === 'Customer') {
    const [vehicles, visits, calls, followUps, appointments, entries] = await Promise.all([
      transaction.vehicle.findMany({ where: { customerId: record.id }, select: { id: true } }),
      transaction.workshopVisit.findMany({ where: { customerId: record.id }, select: { id: true } }),
      transaction.callLog.findMany({ where: { customerId: record.id }, select: { id: true } }),
      transaction.followUp.findMany({ where: { customerId: record.id }, select: { id: true } }),
      transaction.appointment.findMany({ where: { customerId: record.id }, select: { id: true } }),
      transaction.monthlyCustomerDataEntry.findMany({ where: { customerId: record.id }, select: { id: true } }),
    ]);
    add('Vehicle', vehicles);
    add('WorkshopVisit', visits);
    add('CallLog', calls);
    add('FollowUp', followUps);
    add('Appointment', appointments);
    add('MonthlyCustomerDataEntry', entries);
  } else if (type === 'Vehicle') {
    const [visits, allocations, calls, followUps, appointments, ownership, entries, milestones, callList, reviews] = await Promise.all([
      transaction.workshopVisit.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.allocation.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.callLog.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.followUp.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.appointment.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.vehicleOwnershipHistory.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.monthlyCustomerDataEntry.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.freeServiceMilestone.findMany({ where: { vehicleId: record.id }, select: { id: true } }),
      transaction.masterCallList.findMany({ where: { vin: record.vin }, select: { id: true } }),
      transaction.vINConflictReview.findMany({ where: { vin: record.vin }, select: { id: true } }),
    ]);
    add('WorkshopVisit', visits);
    add('Allocation', allocations);
    add('CallLog', calls);
    add('FollowUp', followUps);
    add('Appointment', appointments);
    add('VehicleOwnershipHistory', ownership);
    add('MonthlyCustomerDataEntry', entries);
    add('FreeServiceMilestone', milestones);
    add('MasterCallList VIN reference', callList);
    add('VINConflictReview', reviews);
  } else if (type === 'WorkshopVisit') {
    const milestones = await transaction.freeServiceMilestone.findMany({
      where: { vehicleId: record.vehicleId },
      select: { id: true, completedByWorkshopVisitId: true, completedByRepairOrderNo: true },
    });
    add('FreeServiceMilestone repair-order reference', milestones.filter(({
      completedByWorkshopVisitId,
      completedByRepairOrderNo,
    }) => (
      completedByWorkshopVisitId === record.id
      || (completedByWorkshopVisitId == null
        && completedByRepairOrderNo != null
        && normalizeRepairOrderNo(completedByRepairOrderNo) === normalizeRepairOrderNo(record.repairOrderNo))
    )));
  } else if (type === 'Appointment') {
    add('AppointmentEvent', await transaction.appointmentEvent.findMany({
      where: { appointmentId: record.id },
      select: { id: true },
    }));
  }
  return dependencies.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

async function inspectBatch(transaction, batchId, allChanges = null) {
  const batch = await transaction.importBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      fileName: true,
      status: true,
      createdAt: true,
      processingStartedAt: true,
      totalRows: true,
      rollbackSupported: true,
      allocationEvidenceState: true,
      allocationChangeCount: true,
      rolledBackAt: true,
      rollbackError: true,
    },
  });
  if (!batch) return null;
  const [changes, rowProgress, rowErrors, auditLogs] = await Promise.all([
    allChanges
      ? Promise.resolve(allChanges.filter(({ importBatchId }) => importBatchId === batchId))
      : transaction.importChangeLog.findMany({ where: { importBatchId: batchId }, orderBy: [{ sequence: 'asc' }, { id: 'asc' }] }),
    transaction.importRowProgress.findMany({ where: { importBatchId: batchId }, orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }] }),
    transaction.importRowError.findMany({ where: { importBatchId: batchId }, select: { id: true, rowNumber: true, errorCode: true } }),
    transaction.auditLog.findMany({
      where: { entityType: 'ImportBatch', entityId: batchId },
      select: { id: true, action: true, createdAt: true, details: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { batch, changes, rowProgress, rowErrors, auditLogs };
}

async function inspectRecord(transaction, batch, changes, logsByEntity, evidenceComplete) {
  const firstCreate = changes.filter(({ operation }) => operation === 'CREATE');
  const groups = new Map();
  for (const change of changes) {
    const key = `${change.entityType}:${change.entityId}`;
    const group = groups.get(key) || [];
    group.push(change);
    groups.set(key, group);
  }

  const results = [];
  for (const [key, entityChanges] of groups) {
    const [entityType, entityId] = key.split(':');
    const config = entities[entityType];
    if (!config) {
      results.push({
        entityType,
        entityId,
        batchId: batch.id,
        classification: 'cannot_be_safely_attributed',
        evidence: ['Unsupported change-log entity type.'],
        currentState: null,
        dependencies: [],
        attributionBlockers: [{
          code: 'unsupported_entity_type',
          entityType,
          entityId,
          message: `Entity type ${entityType} is not supported by the legacy reconciler.`,
        }],
        recommendedAction: 'Do not clean up; investigate the unsupported entity type.',
        reason: 'The available service cannot inspect this entity safely.',
      });
      continue;
    }
    const record = await transaction[config.delegate].findUnique({ where: { id: entityId } });
    const batchRollbackMetadataInvalid = batch.rolledBackAt != null || batch.rollbackError != null;
    const invalidated = batch.status === DELETED
      || batch.status === 'rolled_back'
      || batchRollbackMetadataInvalid
      || entityChanges.some(({ rollbackStatus, rolledBackAt, rollbackError }) => (
        rollbackStatus !== 'pending' || rolledBackAt != null || rollbackError != null
      ));
    const admissibleBatchStatus = ['completed', 'failed'].includes(batch.status);
    const expected = !invalidated && admissibleBatchStatus ? applyChanges(entityChanges) : null;
    const otherBatchLogs = (logsByEntity.get(key) || []).filter(({ importBatchId }) => importBatchId !== batch.id);
    const dependencies = record ? await findDependencies(transaction, entityType, record) : [];
    const hasCreate = firstCreate.some(({ entityType: type, entityId: id }) => type === entityType && id === entityId);
    const snapshotMatches = !invalidated && admissibleBatchStatus
      && Boolean(expected && record && equal(stable(record), expected));
    const supportedLog = entityChanges.every(importChangeLogIsComplete);
    const evidence = [
      `Batch ${batch.id} retained ${entityChanges.length} change-log record(s).`,
      supportedLog ? 'Snapshots satisfy current structural validation.' : 'One or more snapshots are incomplete or unsupported.',
      invalidated
        ? batchRollbackMetadataInvalid
          ? 'Snapshot matching was not used because batch-level rollback metadata is contradictory and evidence is report-only.'
          : 'Snapshot matching was not used because invalidated evidence is report-only.'
        : snapshotMatches
          ? 'Current entity matches the complete recorded state.'
          : 'Current entity does not match the recorded state or is missing.',
      otherBatchLogs.length ? `${otherBatchLogs.length} change log(s) from other batches reference this entity.` : 'No other import change logs reference this entity.',
    ];
    let classification = 'cannot_be_safely_attributed';
    let reason = 'No complete CREATE evidence proves this batch created the current record.';
    if (invalidated) {
      classification = 'invalidated_evidence';
      reason = batchRollbackMetadataInvalid
        ? 'Batch-level rollback metadata is contradictory; its snapshots are report-only and cannot authorize cleanup.'
        : 'The batch or its change logs are invalidated; their snapshots are report-only and cannot authorize cleanup.';
    } else if (hasCreate && supportedLog) {
      classification = snapshotMatches && !otherBatchLogs.length
        ? 'verified_attributable'
        : 'requires_investigation';
      reason = snapshotMatches && !otherBatchLogs.length
        ? 'The retained CREATE evidence and full current snapshot independently identify this record; dependency checks still govern cleanup.'
        : 'The record has a CREATE log, but its current state or cross-batch history is unresolved.';
    } else if (entityChanges.some(({ operation }) => operation === 'UPDATE') && supportedLog) {
      classification = 'requires_investigation';
      reason = 'An UPDATE proves recorded fields changed, but does not prove that the batch created this entity or that the original state remains safely restorable.';
    }
    const cleanupEligible = classification === 'verified_attributable'
      && hasCreate
      && isLegacyCandidateBatch(batch, changes)
      && admissibleBatchStatus
      && !invalidated
      && evidenceComplete
      && entityChanges.every(({ rollbackStatus, rolledBackAt, rollbackError }) => (
        rollbackStatus === 'pending' && rolledBackAt == null && rollbackError == null
      ));
    const attributionBlockers = [];
    if (!evidenceComplete) attributionBlockers.push({
      code: 'incomplete_batch_evidence',
      entityType,
      entityId,
      message: 'The batch row outcomes or mutation evidence are incomplete.',
    });
    if (!supportedLog) attributionBlockers.push({
      code: 'incomplete_change_evidence',
      entityType,
      entityId,
      message: 'One or more change-log snapshots are incomplete or unsupported.',
    });
    if (!record) attributionBlockers.push({
      code: 'target_entity_missing',
      entityType,
      entityId,
      message: `The target ${entityType} no longer exists.`,
    });
    if (hasCreate && record && !invalidated && admissibleBatchStatus && !snapshotMatches) attributionBlockers.push({
      code: 'current_snapshot_mismatch',
      entityType,
      entityId,
      message: 'Current entity values differ from the complete state recorded for the import.',
    });
    if (otherBatchLogs.length) attributionBlockers.push({
      code: 'cross_batch_change_log',
      entityType,
      entityId,
      message: 'Other import batches also have change logs for this entity.',
    });
    if (!hasCreate) attributionBlockers.push({
      code: 'update_reversal_unsupported',
      entityType,
      entityId,
      message: 'Legacy cleanup only reverses independently verified CREATE records; UPDATE restoration is not automated.',
    });
    if (invalidated) {
      attributionBlockers.push({
        code: 'invalidated_evidence_not_authority',
        entityType,
        entityId,
        message: 'One or more change logs or the batch are invalidated. This evidence is report-only and cannot authorize record cleanup.',
      });
    }
    if (batchRollbackMetadataInvalid) {
      const metadataIssues = [
        batch.rolledBackAt != null ? 'rolledBackAt is set' : null,
        batch.rollbackError != null ? 'rollbackError is set' : null,
      ].filter(Boolean);
      attributionBlockers.push({
        code: 'batch_rollback_metadata_unverified',
        entityType,
        entityId,
        importBatchId: batch.id,
        message: `Import batch ${batch.id} has contradictory rollback metadata (${metadataIssues.join(', ')}); reversal cannot be independently verified and its logs cannot authorize cleanup.`,
      });
    }
    if (batch.status === 'rolled_back') attributionBlockers.push({
      code: 'rolled_back_batch',
      entityType,
      entityId,
      message: 'A rolled-back batch requires investigation and is not eligible for automatic legacy cleanup.',
    });
    results.push({
      entityType,
      entityId,
      batchId: batch.id,
      record: recordLabel(entityType, record || { id: entityId }),
      classification,
      evidence,
      evidenceFingerprint: createHash('sha256').update(JSON.stringify(stable(entityChanges))).digest('hex'),
      currentState: record ? safeCurrentState(record) : null,
      dependencies,
      attributionBlockers,
      invalidated,
      recommendedAction: cleanupEligible && !dependencies.length
        ? 'Eligible for exact-record cleanup after a fresh confirmation preview.'
        : dependencies.length
          ? 'Do not delete; resolve dependencies manually and rerun the read-only preview.'
          : classification === 'requires_investigation'
            ? 'Investigate snapshots and cross-batch history; do not infer ownership.'
            : 'Do not delete; attribution is not established.',
      reason: dependencies.length ? 'One or more records reference this entity.' : reason,
      cleanupEligible,
      cleanupBlockers: dependencies,
      cleanupSequence: entityChanges
        .filter(({ operation }) => operation === 'CREATE')
        .reduce((latest, change) => Math.max(latest, change.sequence), 0),
    });
  }
  return results;
}

async function loadReconciliation(transaction) {
  const batches = await transaction.importBatch.findMany({
    select: {
      id: true,
      fileName: true,
      status: true,
      createdAt: true,
      processingStartedAt: true,
      totalRows: true,
      rollbackSupported: true,
      allocationEvidenceState: true,
      allocationChangeCount: true,
      rolledBackAt: true,
      rollbackError: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const changes = batches.length
    ? await transaction.importChangeLog.findMany({
      where: { importBatchId: { in: batches.map(({ id }) => id) } },
      orderBy: [{ importBatchId: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
    })
    : [];
  const logsByEntity = new Map();
  for (const change of changes) {
    const key = `${change.entityType}:${change.entityId}`;
    const group = logsByEntity.get(key) || [];
    group.push(change);
    logsByEntity.set(key, group);
  }
  const batchReports = [];
  const records = [];
  for (const batch of batches) {
    const batchChanges = changes.filter(({ importBatchId }) => importBatchId === batch.id);
    const isLegacy = isLegacyCandidateBatch(batch, batchChanges)
      || !batch.processingStartedAt
      || !batch.rollbackSupported;
    if (!isLegacy) continue;
    const inspection = await inspectBatch(transaction, batch.id, changes);
    const complete = mutationEvidenceIsComplete(batch, inspection.changes, inspection.rowProgress);
    const invalidatedCount = inspection.changes.filter(({ rollbackStatus }) => rollbackStatus === DELETED).length;
    const batchRecords = await inspectRecord(
      transaction,
      batch,
      inspection.changes,
      logsByEntity,
      complete,
    );
    records.push(...batchRecords);
    batchReports.push({
      id: batch.id,
      fileName: batch.fileName,
      status: batch.status,
      createdAt: batch.createdAt,
      rolledBackAt: batch.rolledBackAt,
      rollbackError: batch.rollbackError,
      rollbackMetadataInvalid: batch.rolledBackAt != null || batch.rollbackError != null,
      totalRows: batch.totalRows,
      rowProgressCount: inspection.rowProgress.length,
      rowErrorCount: inspection.rowErrors.length,
      changeLogCount: inspection.changes.length,
      invalidatedChangeLogCount: invalidatedCount,
      auditEvents: inspection.auditLogs.map(({ id, action, createdAt }) => ({ id, action, createdAt })),
      evidenceComplete: complete,
      pendingEvidence: inspection.changes.length > 0
        && inspection.changes.every(({ rollbackStatus }) => rollbackStatus === 'pending')
        && complete,
      potentiallyEligibleForNormalDeletion: ['completed', 'failed'].includes(batch.status)
        && batch.rollbackSupported
        && complete
        && inspection.changes.every(({ rollbackStatus }) => rollbackStatus === 'pending'),
      recordIds: batchRecords.map(({ entityType, entityId, classification }) => ({ entityType, entityId, classification })),
    });
  }
  const countsByStatus = {};
  for (const batch of batchReports) countsByStatus[batch.status] = (countsByStatus[batch.status] || 0) + 1;
  const uniqueRecords = new Map();
  for (const item of records) {
    const key = `${item.batchId}:${item.entityType}:${item.entityId}`;
    uniqueRecords.set(key, item);
  }
  const recordList = [...uniqueRecords.values()];
  const verifiedAttributable = recordList.filter(({ classification }) => classification === 'verified_attributable').length;
  const requiresInvestigation = recordList.filter(({ classification }) => classification === 'requires_investigation').length;
  const cannotAttribute = recordList.filter(({ classification }) => classification === 'cannot_be_safely_attributed').length;
  return {
    summary: {
      totalHistoricalBatchesInspected: batchReports.length,
      countsByStatus,
      batchesWithInvalidatedChangeLogs: batchReports.filter(({ invalidatedChangeLogCount }) => invalidatedChangeLogCount > 0).length,
      batchesWithIncompleteEvidence: batchReports.filter(({ evidenceComplete }) => !evidenceComplete).length,
      potentiallyEligibleForNormalPhase2Deletion: batchReports.filter(({ potentiallyEligibleForNormalDeletion }) => potentiallyEligibleForNormalDeletion).length,
      totalSurvivingRecordsPotentiallyAssociated: recordList.filter(({ currentState }) => currentState !== null).length,
      verifiedAttributableRecords: verifiedAttributable,
      recordsRequiringInvestigation: requiresInvestigation,
      recordsNotSafelyAttributable: cannotAttribute,
      recordsWithDependencies: recordList.filter(({ dependencies }) => dependencies.length > 0).length,
    },
    batches: batchReports,
    records: recordList,
  };
}

function cleanupPlan(report, batchId) {
  const batch = report.batches.find(({ id }) => id === batchId);
  if (!batch) throw new LegacyImportReconciliationConflict('No historical reconciliation batch with that ID was found.');
  const allCandidates = report.records.filter(({ batchId: id, cleanupEligible }) => id === batchId && cleanupEligible);
  const candidateKeys = new Set(allCandidates.map(({ entityType, entityId }) => `${entityType}:${entityId}`));
  const dependencyEntityType = {
    Vehicle: 'Vehicle',
    WorkshopVisit: 'WorkshopVisit',
    Allocation: 'Allocation',
    CallLog: 'CallLog',
    FollowUp: 'FollowUp',
    Appointment: 'Appointment',
    VehicleOwnershipHistory: 'VehicleOwnershipHistory',
    MonthlyCustomerDataEntry: 'MonthlyCustomerDataEntry',
    FreeServiceMilestone: 'FreeServiceMilestone',
    'MasterCallList VIN reference': 'MasterCallList',
    VINConflictReview: 'VINConflictReview',
  };
  const candidates = allCandidates.filter((candidate) => candidate.cleanupBlockers.every((dependency) => {
    const type = dependencyEntityType[dependency.kind];
    return type && candidateKeys.has(`${type}:${dependency.id}`);
  }));
  const selectedKeys = new Set(candidates.map(({ entityType, entityId }) => `${entityType}:${entityId}`));
  let removedCandidate;
  do {
    removedCandidate = false;
    for (const candidate of [...candidates]) {
      const hasUnscheduledReference = candidate.cleanupBlockers.some((dependency) => {
        const type = dependencyEntityType[dependency.kind];
        return !type || !selectedKeys.has(`${type}:${dependency.id}`);
      });
      if (hasUnscheduledReference) {
        candidates.splice(candidates.indexOf(candidate), 1);
        selectedKeys.delete(`${candidate.entityType}:${candidate.entityId}`);
        removedCandidate = true;
      }
    }
  } while (removedCandidate);
  const blockers = allCandidates
    .filter((candidate) => !candidates.includes(candidate))
    .flatMap((candidate) => candidate.cleanupBlockers.map((dependency) => ({
      code: 'unresolved_dependency',
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      relatedEntityType: dependency.kind,
      relatedEntityId: dependency.id,
      message: `Record ${dependency.kind} ${dependency.id} still references this candidate and is not included in the verified cleanup plan.`,
    })));
  blockers.push(...report.records
    .filter((record) => record.batchId === batchId && !record.cleanupEligible)
    .flatMap(({ attributionBlockers = [] }) => attributionBlockers));
  blockers.push(...report.records
    .filter((record) => record.batchId === batchId && !record.cleanupEligible)
    .flatMap((record) => record.dependencies.map((dependency) => ({
      code: 'unresolved_dependency',
      entityType: record.entityType,
      entityId: record.entityId,
      relatedEntityType: dependency.kind,
      relatedEntityId: dependency.id,
      message: `Record ${dependency.kind} ${dependency.id} still references this record and will not be deleted.`,
    }))));
  if (!['permanently_deleted', 'completed', 'failed'].includes(batch.status)) {
    blockers.push({ code: 'unsupported_batch_status', message: `Batch status ${batch.status} is not eligible for legacy cleanup.` });
  }
  if (!candidates.length) {
    blockers.push({ code: 'no_verified_cleanup_candidates', message: 'No surviving record has independently verified, exact CREATE evidence eligible for cleanup.' });
  }
  const candidateByKey = new Map(candidates.map((candidate) => [
    `${candidate.entityType}:${candidate.entityId}`,
    candidate,
  ]));
  const orderedCandidates = [];
  const visited = new Set();
  const visiting = new Set();
  let dependencyCycle = false;
  const visit = (candidate) => {
    const key = `${candidate.entityType}:${candidate.entityId}`;
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      dependencyCycle = true;
      return;
    }
    visiting.add(key);
    for (const dependency of candidate.cleanupBlockers) {
      const type = dependencyEntityType[dependency.kind];
      const child = candidateByKey.get(`${type}:${dependency.id}`);
      if (child) visit(child);
    }
    visiting.delete(key);
    visited.add(key);
    orderedCandidates.push(candidate);
  };
  for (const candidate of candidates) visit(candidate);
  if (dependencyCycle) {
    blockers.push({ code: 'dependency_cycle', message: 'The verified cleanup candidates contain a dependency cycle.' });
  }
  const sortedCandidates = orderedCandidates;
  return {
    batch,
    candidates: sortedCandidates,
    blockers: publicBlockers(blockers),
    confirmationToken: blockers.length ? null : createHash('sha256').update(JSON.stringify(stable({
      batch,
      candidates: sortedCandidates.map(({
        entityType,
        entityId,
        evidence,
        evidenceFingerprint,
        currentState,
        cleanupSequence,
      }) => ({
        entityType,
        entityId,
        evidence,
        evidenceFingerprint,
        currentState,
        cleanupSequence,
        dependencies: report.records.find((item) => item.batchId === batchId
          && item.entityType === entityType && item.entityId === entityId)?.dependencies || [],
      })),
      blockers: publicBlockers(blockers),
    }))).digest('hex'),
  };
}

export async function previewLegacyImportReconciliation(database = prisma) {
  return database.$transaction((transaction) => loadReconciliation(transaction), { isolationLevel: 'RepeatableRead' });
}

export async function previewLegacyImportCleanup(batchId, database = prisma) {
  return database.$transaction(async (transaction) => {
    const report = await loadReconciliation(transaction);
    const plan = cleanupPlan(report, batchId);
    return {
      batch: plan.batch,
      recordsToDelete: plan.candidates.map(({ entityType, entityId, record, evidence, cleanupBlockers }) => ({
        entityType,
        entityId,
        record,
        evidence,
        currentState: report.records.find((item) => item.batchId === batchId
          && item.entityType === entityType && item.entityId === entityId)?.currentState || null,
        dependencies: cleanupBlockers,
      })),
      blockers: plan.blockers,
      confirmationToken: plan.confirmationToken,
    };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function cleanupLegacyImport(batchId, adminId, confirmationToken, database = prisma) {
  if (!confirmationToken) throw new LegacyImportReconciliationConflict('A fresh cleanup preview and confirmation token are required.');
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "import_batches" WHERE "id" = ${batchId} FOR UPDATE`;
    let report = await loadReconciliation(transaction);
    let plan = cleanupPlan(report, batchId);
    if (plan.blockers.length) throw new LegacyImportReconciliationConflict('Legacy cleanup is blocked.', plan.blockers);

    const records = plan.candidates.map(({ entityType, entityId }) => ({ entityType, entityId }));
    for (const entry of records) {
      const config = entities[entry.entityType];
      await transaction.$queryRawUnsafe(
        `SELECT "id" FROM "${config.table}" WHERE "id" = $1 FOR UPDATE`,
        entry.entityId,
      );
    }
    report = await loadReconciliation(transaction);
    plan = cleanupPlan(report, batchId);
    if (plan.blockers.length || plan.confirmationToken !== confirmationToken) {
      throw new LegacyImportReconciliationConflict('The legacy cleanup plan changed. Refresh the reconciliation preview.', plan.blockers);
    }

    for (const candidate of plan.candidates) {
      const config = entities[candidate.entityType];
      const deleted = await transaction[config.delegate].deleteMany({ where: { id: candidate.entityId } });
      if (deleted.count !== 1) {
        throw new LegacyImportReconciliationConflict(`Record ${candidate.entityType} ${candidate.entityId} changed during cleanup.`);
      }
    }
    await transaction.auditLog.create({
      data: {
        userId: adminId,
        entityType: 'ImportBatch',
        entityId: batchId,
        action: 'LEGACY_IMPORT_RECONCILIATION_CLEANUP',
        details: JSON.stringify({
          records: plan.candidates.map(({ entityType, entityId }) => ({ entityType, entityId })),
          evidenceStatusUnchanged: true,
        }),
      },
    });
    return {
      status: 'legacy_cleanup_completed',
      deletedRecords: plan.candidates.map(({ entityType, entityId }) => ({ entityType, entityId })),
    };
  }, { isolationLevel: 'Serializable' });
}
