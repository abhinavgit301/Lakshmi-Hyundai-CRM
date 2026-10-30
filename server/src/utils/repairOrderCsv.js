import { parse } from 'csv-parse/sync';

const HEADER_ALIASES = {
  sno: 'serialNo',
  serialno: 'serialNo',
  ronumber: 'roNumber',
  rono: 'roNumber',
  repairorder: 'roNumber',
  repairorderno: 'roNumber',
  repairordernumber: 'roNumber',
  rodate: 'visitDate',
  repairorderdate: 'visitDate',
  closingdate: 'closingDate',
  gpdate: 'gpDate',
  worktype: 'workType',
  status: 'serviceStatus',
  serviceadvisor: 'serviceAdvisor',
  vehiclevin: 'vin',
  vin: 'vin',
  regno: 'registrationNumber',
  registrationnumber: 'registrationNumber',
  model: 'model',
  mileage: 'mileage',
  saledealer: 'saleDealer',
  saledate: 'saleDate',
  ucsaledealer: 'ucSaleDealer',
  ucsaledate: 'ucSaleDate',
  customername: 'customerName',
  name: 'customerName',
  address: 'address',
  email: 'email',
  emailaddress: 'email',
  city: 'city',
  pin: 'pin',
  pincode: 'pin',
  mobile: 'mobileNumber',
  mobileno: 'mobileNumber',
  mobilenumber: 'mobileNumber',
  phoneno: 'mobileNumber',
  phone: 'mobileNumber',
  phonenumber: 'mobileNumber',
  registrationno: 'registrationNumber',
  office: 'office',
  tech: 'technician',
  technician: 'technician',
  specialmsg: 'specialMessage',
  specialmessage: 'specialMessage',
  visittype: 'visitType',
  demands: 'demands',
  make: 'make',
  variant: 'variant',
  year: 'year',
  ccmid: 'ccmId',
  laborcost: 'totalLaborCost',
  totallaborcost: 'totalLaborCost',
  partscost: 'totalPartsCost',
  totalpartscost: 'totalPartsCost',
};

function normalizeHeader(header) {
  const key = String(header || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[key] || key;
}

function parseHeaderCandidate(headerRow) {
  const headers = headerRow.map(normalizeHeader);
  const required = ['roNumber', 'vin'];
  return required.every((field) => headers.includes(field)) ? headers : null;
}

function rowToObject(headers, values) {
  const row = {};
  headers.forEach((header, index) => {
    if (!header) return;
    row[header] = values[index] ?? '';
  });
  return row;
}

export function parseRepairOrderCsv(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return { error: 'CSV content is required.' };
  }

  try {
    const records = parse(content, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      info: true,
      relax_column_count: true,
    });

    const headerIndex = records.findIndex(({ record }) => parseHeaderCandidate(record));
    if (headerIndex === -1) {
      return { error: 'CSV is missing required columns: roNumber, vin.' };
    }

    const headers = parseHeaderCandidate(records[headerIndex].record);
    const dataRecords = records.slice(headerIndex + 1);
    if (dataRecords.length > 10000) return { error: 'A single import cannot exceed 10000 rows.' };

    return {
      rows: dataRecords.map(({ record, info }, index) => ({
        rowNumber: info.lines || headerIndex + index + 2,
        row: rowToObject(headers, record),
      })),
    };
  } catch (error) {
    return { error: `CSV could not be parsed: ${error.message}` };
  }
}

export function parseRepairOrderDate(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const compactDate = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  const localDate = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const date = compactDate
    ? new Date(Number(compactDate[1]), Number(compactDate[2]) - 1, Number(compactDate[3]))
    : localDate
      ? new Date(Number(localDate[3]), Number(localDate[2]) - 1, Number(localDate[1]))
      : new Date(raw);
  if ((localDate || compactDate) && (
    Number.isNaN(date.getTime())
    || (compactDate && (
      date.getFullYear() !== Number(compactDate[1])
      || date.getMonth() !== Number(compactDate[2]) - 1
      || date.getDate() !== Number(compactDate[3])
    ))
    || (localDate && (
      date.getFullYear() !== Number(localDate[3])
      || date.getMonth() !== Number(localDate[2]) - 1
      || date.getDate() !== Number(localDate[1])
    ))
  )) return NaN;
  return Number.isNaN(date.getTime()) ? NaN : date;
}