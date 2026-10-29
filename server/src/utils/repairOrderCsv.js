import { parse } from 'csv-parse/sync';

const HEADER_ALIASES = {
  sno: 'serialNo',
  serialno: 'serialNo',
  ronumber: 'roNumber',
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
  city: 'city',
  pin: 'pin',
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
  const key = String(header || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[key] || key;
}

export function parseRepairOrderCsv(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return { error: 'CSV content is required.' };
  }

  try {
    let headers = [];
    const records = parse(content, {
      bom: true,
      columns: (sourceHeaders) => {
        headers = sourceHeaders.map(normalizeHeader);
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      info: true,
    });

    const required = ['roNumber', 'vin', 'customerName', 'mobileNumber'];
    const missing = required.filter((header) => !headers.includes(header));
    if (missing.length) {
      return { error: `CSV is missing required columns: ${missing.join(', ')}.` };
    }
    if (records.length > 10000) {
      return { error: 'A single import cannot exceed 10000 rows.' };
    }

    return {
      rows: records.map(({ record, info }, index) => ({
        rowNumber: info.lines || index + 2,
        row: record,
      })),
    };
  } catch (error) {
    return { error: `CSV could not be parsed: ${error.message}` };
  }
}