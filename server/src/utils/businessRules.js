import { buildDuplicateKey, isValidVin, normalizeVin } from './roleAccess.js';

export function evaluateRepairOrderRow(row = {}, existingKeys = []) {
  const normalizedVin = normalizeVin(row.vin || '');
  const repairOrderNumber = String(row.roNumber || '').trim();

  if (!normalizedVin || !isValidVin(normalizedVin)) {
    return {
      status: 'rejected',
      reason: 'Missing or invalid VIN',
      normalizedVin: '',
      repairOrderNumber,
    };
  }

  if (!repairOrderNumber) {
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
