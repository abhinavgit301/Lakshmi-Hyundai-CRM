import { noteCreOwnershipChange } from './creCallAggregates.js';

export function assignmentHistoryEventType(previousCreId, newCreId) {
  if (previousCreId == null && newCreId != null) return 'ASSIGNED';
  if (previousCreId != null && newCreId == null) return 'UNASSIGNED';
  return 'REASSIGNED';
}

export async function recordCreAssignmentEvent(transaction, {
  vehicleId = null,
  allocationId = null,
  masterCallListId = null,
  ccmId,
  previousCreId = null,
  newCreId = null,
  actorUserId = null,
  reason = null,
  eventType,
}) {
  if (previousCreId === newCreId) return null;
  if (!ccmId || (!allocationId && !masterCallListId) || (!vehicleId && (!masterCallListId || allocationId))) {
    throw new Error('CRE assignment history requires a CCM and assignment reference; allocations require a vehicle.');
  }
  // Ownership decides which calls count for a CRE; the enclosing transaction flushes the aggregates.
  noteCreOwnershipChange(transaction, { ccmId, creIds: [previousCreId, newCreId] });

  return transaction.creAssignmentHistory.create({
    data: {
      vehicleId,
      allocationId,
      masterCallListId,
      ccmId,
      previousCreId,
      newCreId,
      actorUserId,
      reason,
      eventType: eventType || assignmentHistoryEventType(previousCreId, newCreId),
    },
  });
}

export function validateAssignmentReason(value) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string' || value.trim().length > 2000) {
    return { error: 'Assignment reason must be 2000 characters or fewer.' };
  }
  return { value: value.trim() || null };
}
