import { isValidVin, normalizeVin } from './roleAccess.js';

export function validateCustomerPayload(payload = {}) {
  const fullName = String(payload.fullName || '').trim();
  const mobileNumber = payload.mobileNumber ? String(payload.mobileNumber).trim() : null;
  const alternatePhone = payload.alternatePhone ? String(payload.alternatePhone).trim() : null;
  const email = payload.email ? String(payload.email).trim().toLowerCase() : null;
  const rawVehicles = payload.vehicles ?? [];

  if (!fullName) {
    return { error: 'Customer name is required.' };
  }

  if (fullName.length > 200 || (email && email.length > 254)) {
    return { error: 'Customer name or email is too long.' };
  }

  if (!Array.isArray(rawVehicles) || rawVehicles.length > 20) {
    return { error: 'Vehicles must be a list of no more than 20 entries.' };
  }

  const vehicles = [];
  const seenVins = new Set();

  for (const rawVehicle of rawVehicles) {
    const vin = normalizeVin(rawVehicle?.vin || '');
    if (!isValidVin(vin)) {
      return { error: 'Each vehicle must have a valid VIN.' };
    }
    if (seenVins.has(vin)) {
      return { error: 'A VIN can only be added once per customer.' };
    }
    seenVins.add(vin);

    const year = rawVehicle.year == null || rawVehicle.year === '' ? null : Number(rawVehicle.year);
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1)) {
      return { error: 'Vehicle year is invalid.' };
    }

    vehicles.push({
      vin,
      ccmId: rawVehicle.ccmId == null || String(rawVehicle.ccmId).trim() === ''
        ? null
        : String(rawVehicle.ccmId).trim(),
      registrationNumber: rawVehicle.registrationNumber ? String(rawVehicle.registrationNumber).trim().toUpperCase() : null,
      make: rawVehicle.make ? String(rawVehicle.make).trim() : null,
      model: rawVehicle.model ? String(rawVehicle.model).trim() : null,
      variant: rawVehicle.variant ? String(rawVehicle.variant).trim() : null,
      year,
    });
  }

  return {
    value: {
      fullName,
      mobileNumber,
      alternatePhone,
      email,
      vehicles,
    },
  };
}