import { MASTER_REPAIR_TYPES } from './repairTypes.js';

const DUE_CATEGORIES = ['6m', '1y'];

export function validateMasterCallListFilters(query = {}) {
  const dueCategory = String(query.dueCategory || '').trim();
  const repairType = String(query.repairType || '').trim();
  const search = String(query.search || '').trim();

  if (dueCategory && !['6m', '1y', 'allDue'].includes(dueCategory)) {
    return { error: 'dueCategory must be 6m, 1y, or allDue.' };
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
    if (normalizedRole === 'CCM' && creId) {
      if (creId === 'unassigned' ? record.assigneeId : record.assigneeId !== creId) return false;
    }

    if (dueCategory === 'allDue' && !DUE_CATEGORIES.includes(record.dueCategory)) return false;
    if (dueCategory && dueCategory !== 'allDue' && record.dueCategory !== dueCategory) return false;
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
