export const CALL_OUTCOMES = [
  'CONTACTED',
  'CALLBACK',
  'NOT_INTERESTED',
  'WRONG_NUMBER',
  'APPOINTMENT_SET',
  'FOLLOW_UP_LATER',
  'NO_RESPONSE',
  'OTHER',
];

export const CALL_SOURCES = ['SERVICE', 'FREE_SERVICE', 'WARRANTY'];

export function validateCallLogPayload(payload = {}) {
  const customerId = String(payload.customerId || '').trim();
  const outcome = String(payload.outcome || '').trim().toUpperCase();
  const callSource = String(payload.callSource || 'SERVICE').trim().toUpperCase();
  const vehicleId = payload.vehicleId ? String(payload.vehicleId).trim() : null;
  const milestoneId = payload.milestoneId ? String(payload.milestoneId).trim() : null;
  const notes = payload.notes == null ? null : String(payload.notes).trim();

  if (!customerId) {
    return { error: 'Customer ID is required.' };
  }

  if (!CALL_OUTCOMES.includes(outcome)) {
    return { error: 'Outcome is invalid.' };
  }

  if (!CALL_SOURCES.includes(callSource)) {
    return { error: 'Call source is invalid.' };
  }

  if (callSource === 'WARRANTY' && !vehicleId) {
    return { error: 'A vehicle is required for warranty calls.' };
  }

  if (callSource === 'FREE_SERVICE' && (!vehicleId || !milestoneId)) {
    return { error: 'A vehicle and free-service milestone are required for free-service calls.' };
  }

  if (notes && notes.length > 2000) {
    return { error: 'Notes must be 2000 characters or fewer.' };
  }

  let followUpAt = null;
  if (payload.followUpAt) {
    followUpAt = new Date(payload.followUpAt);
    if (Number.isNaN(followUpAt.getTime())) {
      return { error: 'Follow-up date must be a valid date.' };
    }
  }

  if (['CALLBACK', 'FOLLOW_UP_LATER'].includes(outcome) && !followUpAt) {
    return { error: 'A follow-up date is required for this outcome.' };
  }

  return {
    value: {
      customerId,
      vehicleId,
      outcome,
      callSource,
      milestoneId: callSource === 'FREE_SERVICE' ? milestoneId : null,
      notes: notes || null,
      followUpAt,
    },
  };
}

export function validateFollowUpPayload(payload = {}) {
  const customerId = String(payload.customerId || '').trim();
  const category = String(payload.category || '').trim();
  const notes = payload.notes == null ? null : String(payload.notes).trim();
  const followUpAt = new Date(payload.followUpAt);
  const source = String(payload.source || 'SERVICE').trim().toUpperCase();

  if (!customerId || !category || !payload.followUpAt) {
    return { error: 'Customer ID, category, and follow-up date are required.' };
  }

  if (Number.isNaN(followUpAt.getTime())) {
    return { error: 'Follow-up date must be a valid date.' };
  }

  if (!CALL_SOURCES.includes(source)) {
    return { error: 'Follow-up source is invalid.' };
  }

  if (category.length > 100 || (notes && notes.length > 2000)) {
    return { error: 'Category must be 100 characters or fewer and notes 2000 characters or fewer.' };
  }

  return {
    value: {
      customerId,
      category,
      notes: notes || null,
      followUpAt,
      source,
      vehicleId: payload.vehicleId ? String(payload.vehicleId).trim() : null,
      milestoneId: payload.milestoneId ? String(payload.milestoneId).trim() : null,
    },
  };
}