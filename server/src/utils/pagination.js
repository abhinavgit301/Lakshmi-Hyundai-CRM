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

// Due-list order: due date, then record id as the unique tie-breaker.
export function compareByDueDateThenId(left, right) {
  return left.dueDate - right.dueDate || String(left.id).localeCompare(String(right.id));
}

export function encodeDueCursor(record) {
  return Buffer.from(JSON.stringify([new Date(record.dueDate).toISOString(), String(record.id)])).toString('base64url');
}

export function decodeDueCursor(value) {
  try {
    const [dueDate, id] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const date = new Date(dueDate);
    if (typeof id !== 'string' || !id || Number.isNaN(date.getTime())) return null;
    return { dueDate: date, id };
  } catch {
    return null;
  }
}

// Keyset pagination over records already sorted by compareByDueDateThenId: returns the records strictly
// after the cursor, so a page never repeats or skips rows even if earlier rows change between requests.
// `offset` is still reported (the position of the first returned row) for clients that page by offset.
export function paginateByCursor(records, { limit, cursor }) {
  let start = 0;
  let high = records.length;
  while (start < high) {
    const middle = (start + high) >> 1;
    if (compareByDueDateThenId(records[middle], cursor) > 0) high = middle;
    else start = middle + 1;
  }
  const page = records.slice(start, start + limit);
  return {
    records: page,
    total: records.length,
    limit,
    offset: start,
    hasMore: start + page.length < records.length,
    nextCursor: start + page.length < records.length ? encodeDueCursor(page.at(-1)) : null,
  };
}

export function filterServiceListRecords(records, query = {}) {
  const search = String(query.search || '').trim().toLocaleLowerCase();
  const dueCategory = String(query.dueCategory || '').trim();
  const repairType = String(query.repairType || '').trim();
  const milestone = String(query.milestone || '').trim();
  const graceStatus = String(query.graceStatus || '').trim();
  const contactStatus = String(query.contactStatus || '').trim();
  const assigneeId = String(query.assigneeId || '').trim();
  const followUpStatus = String(query.followUpStatus || '').trim();
  const pastDue = String(query.pastDue || '').trim();
  const dateFilters = {};
  for (const key of ['saleFrom', 'saleTo', 'dueFrom', 'dueTo', 'expiryFrom', 'expiryTo']) {
    const value = String(query[key] || '').trim();
    if (!value) continue;
    const date = parseDateFilter(value);
    if (!date) return { error: `${key} must be a valid YYYY-MM-DD date.` };
    dateFilters[key] = date;
  }
  if (search.length > 200) return { error: 'search must be 200 characters or fewer.' };
  if (dueCategory && !['6m', '1y', 'allDue', 'pastDue'].includes(dueCategory)) {
    return { error: 'dueCategory must be 6m, 1y, allDue, or pastDue.' };
  }
  if (milestone && !['1', '2', '3'].includes(milestone)) return { error: 'milestone must be 1, 2, or 3.' };
  if (graceStatus && !['active', 'upcoming', 'grace', 'expired'].includes(graceStatus)) return { error: 'graceStatus is not supported.' };
  if (contactStatus && !['Contacted', 'Not contacted'].includes(contactStatus)) return { error: 'contactStatus is not supported.' };
  if (followUpStatus && !['scheduled', 'notScheduled'].includes(followUpStatus)) return { error: 'followUpStatus is not supported.' };
  if (pastDue && !['true', 'false'].includes(pastDue)) return { error: 'pastDue must be true or false.' };
  for (const [fromKey, toKey] of [['saleFrom', 'saleTo'], ['dueFrom', 'dueTo'], ['expiryFrom', 'expiryTo']]) {
    if (dateFilters[fromKey] && dateFilters[toKey] && dateFilters[fromKey] > dateFilters[toKey]) {
      return { error: `${fromKey} must not be after ${toKey}.` };
    }
  }
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const inRange = (value, from, to) => {
    if (!from && !to) return true;
    const date = parseDateFilter(value);
    return Boolean(date && (!from || date >= from) && (!to || date <= to));
  };
  const filtered = records.filter((record) => {
    if (dueCategory === 'pastDue' && !isPastDue(record.dueDate, todayStart)) return false;
    if (dueCategory === 'allDue' && !['6m', '1y'].includes(record.dueCategory)) return false;
    if (dueCategory && !['allDue', 'pastDue'].includes(dueCategory) && record.dueCategory !== dueCategory) return false;
    if (pastDue === 'true' && !isPastDue(record.dueDate, todayStart)) return false;
    if (pastDue === 'false' && isPastDue(record.dueDate, todayStart)) return false;
    if (repairType && record.type !== repairType) return false;
    if (milestone && String(record.milestone) !== milestone) return false;
    if (graceStatus === 'active' ? !['upcoming', 'grace'].includes(record.graceStatus) : graceStatus && record.graceStatus !== graceStatus) return false;
    if (contactStatus && record.contactStatus !== contactStatus) return false;
    if (assigneeId && record.assigneeId !== assigneeId) return false;
    if (followUpStatus === 'scheduled' && !record.followUp) return false;
    if (followUpStatus === 'notScheduled' && record.followUp) return false;
    if (!inRange(record.saleDate, dateFilters.saleFrom, dateFilters.saleTo)
      || !inRange(record.dueDate, dateFilters.dueFrom, dateFilters.dueTo)
      || !inRange(record.expiryDate || record.warrantyExpiryDate, dateFilters.expiryFrom, dateFilters.expiryTo)) return false;
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

function parseDateFilter(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])
    ? date
    : null;
}

function isPastDue(value, todayStart) {
  const dueDate = parseDateFilter(value);
  return Boolean(dueDate && dueDate < todayStart);
}
