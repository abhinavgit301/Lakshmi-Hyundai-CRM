export const APPOINTMENT_STATUSES = ['PENDING', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW'];

function parseScheduledAt(value) {
  if (!value) return null;
  const scheduledAt = new Date(value);
  return Number.isNaN(scheduledAt.getTime()) ? null : scheduledAt;
}

export function validateAppointmentPayload(payload = {}, { allowCustomerless = false } = {}) {
  const customerId = String(payload.customerId || '').trim();
  const customerName = String(payload.customerName || '').trim();
  const vehicleName = String(payload.vehicleName || '').trim();
  const scheduledAt = parseScheduledAt(payload.scheduledAt);

  if (!customerId && !allowCustomerless) return { error: 'Customer ID is required.' };
  if (!customerId && allowCustomerless && !customerName) return { error: 'Customer name is required.' };
  if (!scheduledAt) return { error: 'A valid appointment date and time are required.' };
  if (scheduledAt.getTime() <= Date.now()) return { error: 'Appointment must be scheduled in the future.' };

  if (payload.vehicleId != null && typeof payload.vehicleId !== 'string') {
    return { error: 'Vehicle ID is invalid.' };
  }

  if (payload.assigneeId != null && typeof payload.assigneeId !== 'string') {
    return { error: 'Assignee ID is invalid.' };
  }

  if (payload.confirmationCall != null && typeof payload.confirmationCall !== 'boolean') {
    return { error: 'Confirmation call must be true or false.' };
  }

  return {
    value: {
      customerId,
      customerName,
      vehicleName,
      vehicleId: payload.vehicleId ? payload.vehicleId.trim() : null,
      assigneeId: payload.assigneeId ? payload.assigneeId.trim() : null,
      scheduledAt,
      confirmationCall: payload.confirmationCall === true,
    },
  };
}

export function validateAppointmentUpdate(payload = {}) {
  const value = {};

  if (payload.status != null) {
    const status = String(payload.status).trim().toUpperCase();
    if (!APPOINTMENT_STATUSES.includes(status)) return { error: 'Appointment status is invalid.' };
    value.status = status;
  }

  if (payload.scheduledAt != null) {
    const scheduledAt = parseScheduledAt(payload.scheduledAt);
    if (!scheduledAt) return { error: 'A valid appointment date and time are required.' };
    if (scheduledAt.getTime() <= Date.now()) return { error: 'Appointment must be scheduled in the future.' };
    value.scheduledAt = scheduledAt;
  }

  if (payload.confirmationCall != null) {
    if (typeof payload.confirmationCall !== 'boolean') return { error: 'Confirmation call must be true or false.' };
    value.confirmationCall = payload.confirmationCall;
  }

  if (Object.keys(value).length === 0) return { error: 'At least one appointment field must be updated.' };
  return { value };
}