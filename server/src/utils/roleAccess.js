export const ROLE_PRIORITY = {
  Admin: 4,
  GM: 3,
  CCM: 2,
  CRE: 1,
};

export function toRoleName(value) {
  return String(value || '').trim();
}

export function normalizeVin(value = '') {
  return String(value).trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
}

export function isValidVin(value = '') {
  const normalized = normalizeVin(value);
  return normalized.length >= 8 && normalized.length <= 17 && /^[A-HJ-NPR-Z0-9]+$/.test(normalized);
}

export function buildDuplicateKey(vin = '', roNumber = '') {
  return `${normalizeVin(vin)}::${String(roNumber).trim()}`;
}

export function isCrossManagerConflict(record = {}, targetCcmId) {
  if (!record || !targetCcmId) {
    return false;
  }

  return !!record.ccmId && String(record.ccmId) !== String(targetCcmId);
}

export function canAccessRecord(actor, record = {}) {
  if (!actor) {
    return false;
  }

  const role = toRoleName(actor.role);

  if (role === 'Admin' || role === 'GM') {
    return true;
  }

  if (role === 'CCM') {
    const actorCcmId = actor.ccmId;
    const recordCcmId = record.ccmId || record.ownerCcmId;

    return !recordCcmId || String(actorCcmId) === String(recordCcmId);
  }

  if (role === 'CRE') {
    const actorCcmId = actor.ccmId;
    const recordCcmId = record.ccmId || record.ownerCcmId;
    const sameCcm = !recordCcmId || String(actorCcmId) === String(recordCcmId);
    const isAssigned = !record.assigneeId || String(record.assigneeId) === String(actor.id);

    return sameCcm && isAssigned;
  }

  return false;
}

export function canViewMasterCallList(actor) {
  const role = toRoleName(actor?.role);

  if (role === 'Admin' || role === 'GM') {
    return true;
  }

  if (role === 'CCM') {
    return true;
  }

  return false;
}
