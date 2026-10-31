export function assignmentHistoryEventType(previousCreId, newCreId) {
  if (previousCreId == null && newCreId != null) return 'ASSIGNED';
  if (previousCreId != null && newCreId == null) return 'UNASSIGNED';
  return 'REASSIGNED';
}

export async function recordCreAssignmentEvent(transaction, {
  vehicleId,
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
  if (!vehicleId || !ccmId || (!allocationId && !masterCallListId)) {
    throw new Error('CRE assignment history requires a vehicle, CCM, and allocation or call-list reference.');
  }

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
