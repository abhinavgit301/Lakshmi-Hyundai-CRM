import { buildDuplicateKey, normalizeVin } from './roleAccess.js';
import { buildRepairOrderKey, normalizeRepairOrderNo } from './repairOrderIdentity.js';

export function validateRepairOrderImportFields(row = {}) {
  const roNumber = String(row.roNumber || '').trim();
  const vin = String(row.vin || '').trim();
  if (!roNumber || roNumber === '-') {
    return { code: 'MISSING_REPAIR_ORDER', field: 'Repair Order No' };
  }
  if (!vin || !normalizeVin(vin)) {
    return { code: 'MISSING_VIN', field: 'VIN' };
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
  const normalizedRepairOrderNumber = normalizeRepairOrderNo(repairOrderNumber);
  const repairOrderKey = buildRepairOrderKey(row.ccmId, repairOrderNumber);
  const existingVin = existingKeys instanceof Map
    ? existingKeys.get(repairOrderKey)
    : null;
  const isSameRepairOrder = existingKeys instanceof Map
    ? existingKeys.has(repairOrderKey)
    : existingKeys instanceof Set
      ? existingKeys.has(repairOrderKey)
      : existingKeys.includes(repairOrderKey);

  if (isSameRepairOrder && existingVin && existingVin !== normalizedVin) {
    return {
      status: 'rejected',
      reason: 'Repair order number is already assigned to a different VIN',
      normalizedVin,
      repairOrderNumber,
      duplicateKey,
    };
  }

  if (isSameRepairOrder) {
    return {
      status: 'skipped',
      reason: 'Duplicate repair order number',
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
