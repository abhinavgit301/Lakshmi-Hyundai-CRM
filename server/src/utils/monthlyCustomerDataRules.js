import { isValidVin, normalizeVin } from './roleAccess.js';

export function validateDatasetPeriod(yearValue, monthValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const maximumYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < 2000 || year > maximumYear) {
    return { error: `Year must be between 2000 and ${maximumYear}.` };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: 'Month must be between 1 and 12.' };
  }
  return { value: { year, month } };
}

function parseDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? new Date(value) : new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return NaN;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function validateMonthlyCustomerRow(row = {}) {
  const customerName = String(row.customerName || row.fullName || '').trim();
  const mobileNumber = String(row.mobileNumber || row.mobile || row.phone || '').trim();
  const email = row.email ? String(row.email).trim().toLowerCase() : null;
  const rawVin = String(row.vin || '').trim();
  const vin = rawVin ? normalizeVin(rawVin) : null;
  const registrationNumber = row.registrationNumber ? String(row.registrationNumber).trim().toUpperCase() : null;
  const make = row.make ? String(row.make).trim() : null;
  const model = row.model ? String(row.model).trim() : null;
  const variant = row.variant ? String(row.variant).trim() : null;
  const serviceType = row.serviceType ? String(row.serviceType).trim() : null;
  const notes = row.notes ? String(row.notes).trim() : null;
  const vehicleYear = row.vehicleYear ?? row.year;
  const parsedYear = vehicleYear == null || String(vehicleYear).trim() === '' ? null : Number(vehicleYear);
  const lastVisitDate = parseDate(row.lastVisitDate);
  const nextServiceDueDate = parseDate(row.nextServiceDueDate);

  if (!customerName) return { error: 'Customer name is required.' };
  if (customerName.length > 200) return { error: 'Customer name must be 200 characters or fewer.' };
  const mobileDigits = mobileNumber.replace(/\D/g, '');
  if (mobileDigits.length < 7 || mobileDigits.length > 15) return { error: 'A valid customer mobile number is required.' };
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'Email address is invalid.' };
  if (vin && !isValidVin(vin)) return { error: 'VIN is invalid.' };
  if (parsedYear !== null && (!Number.isInteger(parsedYear) || parsedYear < 1950 || parsedYear > new Date().getFullYear() + 1)) {
    return { error: 'Vehicle year is invalid.' };
  }
  if (Number.isNaN(lastVisitDate) || Number.isNaN(nextServiceDueDate)) return { error: 'Service date is invalid.' };
  if (serviceType && serviceType.length > 100) return { error: 'Service type must be 100 characters or fewer.' };
  if (notes && notes.length > 2000) return { error: 'Notes must be 2000 characters or fewer.' };

  return {
    value: {
      customerName,
      mobileNumber,
      email,
      vin,
      registrationNumber,
      make,
      model,
      variant,
      vehicleYear: parsedYear,
      serviceType,
      lastVisitDate,
      nextServiceDueDate,
      notes,
    },
  };
}

export function monthlyEntryDuplicateKey(row) {
  const vin = normalizeVin(row.vin || '');
  return vin ? `vin:${vin}` : null;
}

export function classifyMonthlyRows(rows, existingKeys = new Set()) {
  const keys = existingKeys instanceof Set ? new Set(existingKeys) : new Set(existingKeys);
  const seenInFile = new Set();
  const classified = [];
  let addedCount = 0;
  let skippedCount = 0;
  let rejectedCount = 0;

  for (const item of rows) {
    const validation = validateMonthlyCustomerRow(item.row);
    if (validation.error) {
      rejectedCount += 1;
      classified.push({ rowNumber: item.rowNumber, row: item.row, status: 'rejected', error: validation.error });
      continue;
    }

    const key = monthlyEntryDuplicateKey(validation.value);
    if (key && (keys.has(key) || seenInFile.has(key))) {
      skippedCount += 1;
      classified.push({ rowNumber: item.rowNumber, row: validation.value, status: 'skipped', error: 'Customer or vehicle is already present in this month.' });
      continue;
    }

    if (key) seenInFile.add(key);
    addedCount += 1;
    classified.push({ rowNumber: item.rowNumber, row: validation.value, status: 'ready' });
  }

  return { rows: classified, addedCount, skippedCount, rejectedCount };
}

export function canAccessCcmMonthlyData(user, ccmId) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'ADMIN') return true;
  return (role === 'CCM' || role === 'CRE') && Boolean(user.ccmId) && user.ccmId === ccmId;
}