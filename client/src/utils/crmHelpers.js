import { CalendarClock, Clock3, Gift, ShieldCheck } from 'lucide-react';

export const dueViews = {
  'Due 1-Year': { kind: 'due', window: '1y', label: '1-Year Due', icon: CalendarClock, callSource: 'SERVICE' },
  'Due 6-Month': { kind: 'due', window: '6m', label: '6-Month Due', icon: Clock3, callSource: 'SERVICE' },
  'Free Service': { kind: 'free', label: 'Free Service', icon: Gift, callSource: 'FREE_SERVICE' },
  Warranty: { kind: 'warranty', label: 'Warranty', icon: ShieldCheck, callSource: 'WARRANTY' },
};

// Follow-up queues under the Follow-ups accordion; each shows only follow-ups created from its own list.

export const followUpViews = {
  'Follow-up Service': { source: 'SERVICE', label: 'Service', icon: Clock3 },
  'Follow-up Free Service': { source: 'FREE_SERVICE', label: 'Free Service', icon: Gift },
  'Follow-up Warranty': { source: 'WARRANTY', label: 'Warranty', icon: ShieldCheck },
};

export const dailyTargetLabels = { callsMade: 'Calls made', callsPickedUp: 'Calls picked up' };

export function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

export function sortRepairOrderVisits(visits = []) {
  return [...visits].sort((left, right) => {
    const leftDate = new Date(left.visitDate || left.importedDetails?.visitDate || left.importedDetails?.roDate || '').getTime();
    const rightDate = new Date(right.visitDate || right.importedDetails?.visitDate || right.importedDetails?.roDate || '').getTime();
    const leftHasDate = Number.isFinite(leftDate);
    const rightHasDate = Number.isFinite(rightDate);
    if (leftHasDate !== rightHasDate) return leftHasDate ? -1 : 1;
    if (leftHasDate && leftDate !== rightDate) return rightDate - leftDate;
    const leftRepairOrder = String(left.repairOrderNo || left.importedDetails?.roNumber || '').trim();
    const rightRepairOrder = String(right.repairOrderNo || right.importedDetails?.roNumber || '').trim();
    if (leftRepairOrder < rightRepairOrder) return -1;
    if (leftRepairOrder > rightRepairOrder) return 1;
    return String(left.vehicleId || '').localeCompare(String(right.vehicleId || ''));
  });
}

export function formatOutcome(outcome) {
  return outcome ? outcome.replaceAll('_', ' ').toLowerCase() : '';
}

export const masterCsvFields = [
  ['serialNo', 'S NO', 'text'],
  ['roNumber', 'Repair Order No', 'text'],
  ['visitDate', 'R/O Date', 'date'],
  ['closingDate', 'Closing Date', 'date'],
  ['gpDate', 'G.P Date', 'date'],
  ['workType', 'Work Type', 'text'],
  ['serviceStatus', 'Status', 'text'],
  ['serviceAdvisor', 'Service Advisor', 'text'],
  ['vin', 'Vehicle VIN', 'text'],
  ['registrationNumber', 'Reg No', 'text'],
  ['model', 'Model', 'text'],
  ['mileage', 'Mileage', 'number'],
  ['saleDealer', 'Sale Dealer', 'text'],
  ['saleDate', 'Sale Date', 'date'],
  ['ucSaleDealer', 'UC Sale Dealer', 'text'],
  ['ucSaleDate', 'UC Sale Date', 'date'],
  ['customerName', 'Customer Name', 'text'],
  ['address', 'Address', 'text'],
  ['email', 'E-mail', 'email'],
  ['city', 'City', 'text'],
  ['pin', 'PIN', 'text'],
  ['mobileNumber', 'Mobile', 'tel'],
  ['office', 'Office', 'text'],
  ['technician', 'Tech.', 'text'],
  ['specialMessage', 'Special Msg.', 'text'],
  ['visitType', 'Visit Type', 'text'],
  ['demands', 'Demands', 'text'],
];

export const masterCsvLabels = Object.fromEntries(masterCsvFields.map(([key, label]) => [key, label]));

export const manualEntryExcludedFields = ['serialNo', 'gpDate', 'ucSaleDate', 'specialMessage', 'visitType', 'demands'];

export function formatVehicleAge(totalMonths) {
  if (totalMonths == null) return '—';
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  return `${years} yr ${months} mo`;
}

export function getLatestImportedDetails(visits) {
  return [...visits].reverse().reduce((details, visit) => {
    Object.entries(visit.importedDetails || {}).forEach(([key, value]) => {
      if (value != null && String(value).trim() !== '') details[key] = value;
    });
    return details;
  }, {});
}

export function getImportedDetail(details, ...keys) {
  const wantedKeys = new Set(keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const match = Object.entries(details).find(([key, value]) =>
    wantedKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')) && value != null && String(value).trim() !== '',
  );
  return match?.[1];
}

export function localDateKey(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildUserTree(users) {
  const gms = users.filter((user) => user.role === 'GM');
  const ccms = users.filter((user) => user.role === 'CCM');
  const cres = users.filter((user) => user.role === 'CRE');
  const freeServiceCres = users.filter((user) => user.role === 'FREE_SERVICE_CRE');
  const rows = [];
  const placedCcms = new Set();
  const placedCres = new Set();
  const placedFreeServiceCres = new Set();

  function addCcm(ccm, depth) {
    placedCcms.add(ccm.id);
    rows.push({ user: ccm, depth });
    cres.filter((cre) => ccm.ccmId && cre.ccmId === ccm.ccmId).forEach((cre) => {
      placedCres.add(cre.id);
      rows.push({ user: cre, depth: depth + 1 });
    });
    freeServiceCres.filter((cre) => ccm.ccmId && cre.ccmId === ccm.ccmId).forEach((cre) => {
      placedFreeServiceCres.add(cre.id);
      rows.push({ user: cre, depth: depth + 1 });
    });
  }

  gms.forEach((gm) => {
    rows.push({ user: gm, depth: 0 });
    ccms.filter((ccm) => ccm.gmId === gm.id).forEach((ccm) => addCcm(ccm, 1));
  });
  ccms.filter((ccm) => !placedCcms.has(ccm.id)).forEach((ccm) => addCcm(ccm, 0));
  cres.filter((cre) => !placedCres.has(cre.id)).forEach((cre) => rows.push({ user: cre, depth: 0 }));
  freeServiceCres.filter((cre) => !placedFreeServiceCres.has(cre.id)).forEach((cre) => rows.push({ user: cre, depth: 0 }));
  users.filter((user) => !['GM', 'CCM', 'CRE', 'FREE_SERVICE_CRE'].includes(user.role)).forEach((user) => rows.push({ user, depth: 0 }));
  return rows;
}

export function masterListQuery(filters) {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit || 50));
  params.set('offset', String(filters.offset || 0));
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.creId) params.set('creId', filters.creId);
  if (filters.dueCategory) params.set('dueCategory', filters.dueCategory);
  if (filters.repairType) params.set('repairType', filters.repairType);
  const query = params.toString();
  return query ? `?${query}` : '';
}
