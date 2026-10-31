export function normalizeRepairOrderNo(value = '') {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function buildRepairOrderKey(ccmId, repairOrderNo) {
  return JSON.stringify([String(ccmId || '').trim(), normalizeRepairOrderNo(repairOrderNo)]);
}
