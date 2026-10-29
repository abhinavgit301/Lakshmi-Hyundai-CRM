export const MASTER_REPAIR_TYPES = [
  'Accidental Repair',
  'Free',
  'Paid',
  'Running Repair',
  'PMS',
  'Others',
];

export function classifyMasterRepairType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (/\b(free|foc)\b/.test(type)) return 'Free';
  if (/\b(accident|accidental|collision|body shop)\b/.test(type)) return 'Accidental Repair';
  if (/\b(running repair|running repairs|rr)\b/.test(type)) return 'Running Repair';
  if (/\b(pms|periodic)\b/.test(type)) return 'PMS';
  if (/\b(paid|chargeable|customer pay|customer-paid|cp)\b/.test(type)) return 'Paid';
  return 'Others';
}
