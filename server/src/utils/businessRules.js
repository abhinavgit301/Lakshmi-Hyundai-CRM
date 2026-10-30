import { buildDuplicateKey, normalizeVin } from './roleAccess.js';

export function validateRepairOrderImportFields(row = {}) {
  const roNumber = String(row.roNumber || '').trim();
  const vin = String(row.vin || '').trim();
  const registrationNumber = String(row.registrationNumber || '').trim();
  if (!roNumber || roNumber === '-') {
    return { code: 'MISSING_REPAIR_ORDER', field: 'Repair Order No' };
  }
  if (!vin || !normalizeVin(vin)) {
    return { code: 'MISSING_VIN', field: 'VIN' };
  }
  if (!registrationNumber || registrationNumber === '-') {
    return { code: 'MISSING_REGISTRATION', field: 'Registration No' };
  }
  return null;
}

export function evaluateRepairOrderRow(row = {}, existingKeys = []) {
  const rawVin = String(row.vin || '').trim();
  const normalizedVin = normalizeVin(rawVin);
  const repairOrderNumber = String(row.roNumber || '').trim();

  if (!rawVin || !normalizedVin) {
    return {
      status: 'rejected',
      reason: 'Missing VIN',
      normalizedVin: '',
      repairOrderNumber,
    };
  }

  if (!repairOrderNumber || repairOrderNumber === '-') {
    return {
      status: 'rejected',
      reason: 'Missing repair order number',
      normalizedVin,
      repairOrderNumber,
    };
  }

  const duplicateKey = buildDuplicateKey(normalizedVin, repairOrderNumber);

  const isDuplicate = existingKeys instanceof Set
    ? existingKeys.has(duplicateKey)
    : existingKeys.includes(duplicateKey);

  if (isDuplicate) {
    return {
      status: 'skipped',
      reason: 'Duplicate RO/VIN combination',
      normalizedVin,
      repairOrderNumber,
      duplicateKey,
    };
  }

  if (row.ccmId && row.ownerCcmId && String(row.ccmId) !== String(row.ownerCcmId)) {
    return {
      status: 'flagged',
      reason: 'Cross-manager VIN conflict',
      normalizedVin,
      repairOrderNumber,
      duplicateKey,
    };
  }

  return {
    status: 'processed',
    reason: 'Ready for import',
    normalizedVin,
    repairOrderNumber,
    duplicateKey,
  };
}
