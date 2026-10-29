import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

const HEADER_ALIASES = {
  customer: 'customerName',
  customername: 'customerName',
  fullname: 'customerName',
  name: 'customerName',
  mobile: 'mobileNumber',
  mobilenumber: 'mobileNumber',
  phone: 'mobileNumber',
  phonenumber: 'mobileNumber',
  email: 'email',
  vin: 'vin',
  registration: 'registrationNumber',
  registrationnumber: 'registrationNumber',
  registrationno: 'registrationNumber',
  regno: 'registrationNumber',
  make: 'make',
  model: 'model',
  variant: 'variant',
  year: 'vehicleYear',
  vehicleyear: 'vehicleYear',
  servicetype: 'serviceType',
  lastvisitdate: 'lastVisitDate',
  lastservicedate: 'lastVisitDate',
  nextserviceduedate: 'nextServiceDueDate',
  duedate: 'nextServiceDueDate',
  notes: 'notes',
};

function normalizeHeader(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[key] || key;
}

function normalizeExcelValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (value.text != null) return value.text;
    if (value.result != null) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
  }
  return value;
}

function parseRowsFromWorksheet(worksheet) {
  if (!worksheet || worksheet.rowCount < 1) return { error: 'Workbook has no worksheet rows.' };
  const headers = worksheet.getRow(1).values.slice(1).map(normalizeHeader);
  const missing = ['customerName', 'mobileNumber'].filter((name) => !headers.includes(name));
  if (missing.length) return { error: `File is missing required columns: ${missing.join(', ')}.` };

  const rows = [];
  worksheet.eachRow((worksheetRow, rowNumber) => {
    if (rowNumber === 1) return;
    const values = worksheetRow.values.slice(1);
    if (values.every((value) => value == null || String(value).trim() === '')) return;
    const row = {};
    headers.forEach((header, index) => {
      if (header) row[header] = normalizeExcelValue(values[index]);
    });
    rows.push({ rowNumber, row });
  });
  if (rows.length > 5000) return { error: 'A monthly data import cannot exceed 5000 rows.' };
  return { rows };
}

export async function parseMonthlyCustomerDataFile({ fileName, content }) {
  if (typeof content !== 'string' || !content) return { error: 'File content is required.' };
  const extension = String(fileName || '').split('.').pop().toLowerCase();

  if (extension === 'csv') {
    try {
      let headers = [];
      const records = parse(content, {
        bom: true,
        columns: (columns) => {
          headers = columns.map(normalizeHeader);
          return headers;
        },
        skip_empty_lines: true,
        trim: true,
        info: true,
      });
      const missing = ['customerName', 'mobileNumber'].filter((name) => !headers.includes(name));
      if (missing.length) return { error: `File is missing required columns: ${missing.join(', ')}.` };
      if (records.length > 5000) return { error: 'A monthly data import cannot exceed 5000 rows.' };
      return { rows: records.map(({ record, info }, index) => ({ rowNumber: info.lines || index + 2, row: record })) };
    } catch (error) {
      return { error: `CSV could not be parsed: ${error.message}` };
    }
  }

  if (extension !== 'xlsx') return { error: 'Only CSV and XLSX files are supported.' };

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(content, 'base64'));
    return parseRowsFromWorksheet(workbook.worksheets[0]);
  } catch (error) {
    return { error: `Excel file could not be parsed: ${error.message}` };
  }
}