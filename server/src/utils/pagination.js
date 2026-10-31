export const MAX_PAGE_SIZE = 50;

export function parsePagination(query = {}, fallbackLimit = MAX_PAGE_SIZE) {
  const hasPagination = Object.hasOwn(query, 'limit') || Object.hasOwn(query, 'offset');
  const limitValue = query.limit === undefined ? fallbackLimit : Number(query.limit);
  const offsetValue = query.offset === undefined ? 0 : Number(query.offset);

  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > MAX_PAGE_SIZE) {
    return { error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.` };
  }
  if (!Number.isInteger(offsetValue) || offsetValue < 0) {
    return { error: 'offset must be a non-negative integer.' };
  }
  return { limit: limitValue, offset: offsetValue, hasPagination };
}

export function paginateRecords(records, { limit, offset }) {
  const page = records.slice(offset, offset + limit);
  return {
    records: page,
    total: records.length,
    limit,
    offset,
    hasMore: offset + page.length < records.length,
  };
}

export function filterServiceListRecords(records, query = {}) {
  const search = String(query.search || '').trim().toLocaleLowerCase();
  const dueCategory = String(query.dueCategory || '').trim();
  const repairType = String(query.repairType || '').trim();
  if (search.length > 200) return { error: 'search must be 200 characters or fewer.' };
  if (dueCategory && !['6m', '1y', 'allDue'].includes(dueCategory)) {
    return { error: 'dueCategory must be 6m, 1y, or allDue.' };
  }
  const filtered = records.filter((record) => {
    if (dueCategory === 'allDue' && !['6m', '1y'].includes(record.dueCategory)) return false;
    if (dueCategory && dueCategory !== 'allDue' && record.dueCategory !== dueCategory) return false;
    if (repairType && record.type !== repairType) return false;
    if (!search) return true;
    return [
      record.name,
      record.customerName,
      record.mobile,
      record.mobileNumber,
      record.vin,
      record.model,
      record.registrationNumber,
      record.milestoneName,
      record.assigneeName,
      record.repairOrderNo,
      record.roNumber,
      ...(record.workshopVisits || []).flatMap((visit) => [visit.repairOrderNo, visit.importedDetails?.roNumber]),
    ].some((value) => String(value || '').toLocaleLowerCase().includes(search));
  });
  return { records: filtered };
}
