const ALLOCATION_STATUSES = ['assigned', 'completed', 'cancelled'];

export function validateAllocationPayload(payload = {}) {
  const vehicleId = String(payload.vehicleId || '').trim();
  const creId = String(payload.creId || '').trim();
  const serviceType = String(payload.serviceType || '').trim();
  const category = payload.category == null ? null : String(payload.category).trim();
  const notes = payload.notes == null ? null : String(payload.notes).trim();

  if (!vehicleId || !creId || !serviceType) {
    return { error: 'Vehicle, CRE, and service type are required.' };
  }
  if (serviceType.length > 100 || (category && category.length > 100) || (notes && notes.length > 2000)) {
    return { error: 'Service type and category must be 100 characters or fewer; notes must be 2000 characters or fewer.' };
  }

  return {
    value: {
      vehicleId,
      creId,
      serviceType,
      category: category || null,
      notes: notes || null,
    },
  };
}

export function validateAllocationUpdate(payload = {}) {
  const value = {};
  if (payload.status != null) {
    const status = String(payload.status).trim().toLowerCase();
    if (!ALLOCATION_STATUSES.includes(status)) return { error: 'Allocation status is invalid.' };
    value.status = status;
  }
  if (payload.creId != null) {
    const creId = String(payload.creId).trim();
    if (!creId) return { error: 'CRE ID cannot be empty.' };
    value.creId = creId;
    value.status = 'assigned';
  }
  if (payload.notes != null) {
    const notes = String(payload.notes).trim();
    if (notes.length > 2000) return { error: 'Notes must be 2000 characters or fewer.' };
    value.notes = notes || null;
  }
  if (Object.keys(value).length === 0) return { error: 'At least one allocation field must be updated.' };
  return { value };
}