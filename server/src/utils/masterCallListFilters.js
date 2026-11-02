import { MASTER_REPAIR_TYPES } from './repairTypes.js';

const DUE_CATEGORIES = ['6m', '1y'];

export function validateMasterCallListFilters(query = {}) {
  const dueCategory = String(query.dueCategory || '').trim();
  const repairType = String(query.repairType || '').trim();
  const search = String(query.search || '').trim();

  if (dueCategory && !['6m', '1y', 'allDue', 'pastDue'].includes(dueCategory)) {
    return { error: 'dueCategory must be 6m, 1y, allDue, or pastDue.' };
  }
  if (repairType && !MASTER_REPAIR_TYPES.includes(repairType)) {
    return { error: 'repairType is not supported.' };
  }
  if (search.length > 200) {
    return { error: 'search must be 200 characters or fewer.' };
  }

  return {
    filters: {
      creId: String(query.creId || '').trim(),
      dueCategory,
      repairType,
      search: search.toLocaleLowerCase(),
    },
  };
}

export function filterMasterCallListRecords(records, filters, role) {
  const normalizedRole = String(role || '').toUpperCase();
  const { creId, dueCategory, repairType, search } = filters;

  return records.filter((record) => {
    if (['CCM', 'ADMIN', 'GM'].includes(normalizedRole) && creId) {
      if (creId === 'unassigned' ? record.assigneeId : record.assigneeId !== creId) return false;
    }

    if (dueCategory === 'pastDue' && !isPastDue(record.dueDate)) return false;
    if (dueCategory === 'allDue' && !DUE_CATEGORIES.includes(record.dueCategory)) return false;
    if (dueCategory && !['allDue', 'pastDue'].includes(dueCategory) && record.dueCategory !== dueCategory) return false;
    if (repairType && record.type !== repairType) return false;

    if (search) {
      const searchValues = [
        record.name,
        record.customerName,
        record.mobile,
        record.vin,
        record.registrationNumber,
        ...(record.workshopVisits || []).flatMap((visit) => [
          visit.repairOrderNo,
          visit.importedDetails?.roNumber,
        ]),
      ];
      if (!searchValues.some((value) => String(value || '').toLocaleLowerCase().includes(search))) return false;
    }

    return true;
  });
}

function isPastDue(value) {
  if (!value) return false;
  const dueDate = new Date(value);
  if (Number.isNaN(dueDate.getTime())) return false;
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return dueDate < todayStart;
}
