export const MASTER_REPAIR_TYPE_PRESENTATION = {
  'Accidental Repair': { short: 'AR', className: 'repair-type-accidental' },
  Free: { short: 'Free', className: 'repair-type-free' },
  Paid: { short: 'Paid', className: 'repair-type-paid' },
  'Running Repair': { short: 'RR', className: 'repair-type-running' },
  PMS: { short: 'PMS', className: 'repair-type-pms' },
  Others: { short: 'Other', className: 'repair-type-other' },
};

export const MASTER_REPAIR_TYPE_ORDER = [
  'Accidental Repair',
  'Free',
  'Paid',
  'Running Repair',
  'PMS',
  'Others',
];

export function getMasterRepairTypePresentation(type) {
  return MASTER_REPAIR_TYPE_PRESENTATION[type] || MASTER_REPAIR_TYPE_PRESENTATION.Others;
}
