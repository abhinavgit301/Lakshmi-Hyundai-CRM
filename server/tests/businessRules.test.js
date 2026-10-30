import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDuplicateKey,
  canAccessRecord,
  isCrossManagerConflict,
  isValidVin,
  normalizeVin,
} from '../src/utils/roleAccess.js';

import {
  evaluateRepairOrderRow as evaluateRow,
  validateRepairOrderImportFields,
} from '../src/utils/businessRules.js';
import { validateCallLogPayload, validateFollowUpPayload } from '../src/utils/workflowRules.js';
import { validateCustomerPayload } from '../src/utils/customerRules.js';
import { validateAppointmentPayload, validateAppointmentUpdate } from '../src/utils/appointmentRules.js';
import { appointmentVisibilityWhere } from '../src/utils/appointmentAccess.js';
import { parseRepairOrderCsv, parseRepairOrderDate } from '../src/utils/repairOrderCsv.js';
import { validateAllocationPayload, validateAllocationUpdate } from '../src/utils/allocationRules.js';
import { canAccessCcmMonthlyData, classifyMonthlyRows, validateDatasetPeriod, validateMonthlyCustomerRow } from '../src/utils/monthlyCustomerDataRules.js';
import { parseMonthlyCustomerDataFile } from '../src/utils/monthlyCustomerDataParser.js';
import ExcelJS from 'exceljs';
import { isValidUsername, normalizeUsername, validateOptionalPhone } from '../src/utils/userRules.js';

test('normalizeVin strips whitespace and invalid characters', () => {
  assert.equal(normalizeVin(' 1hgbh41jxz '), '1HGBH41JXZ');
  assert.equal(normalizeVin('abc-123'), 'ABC123');
});

test('VIN validation rejects invalid values', () => {
  assert.equal(isValidVin('1HGBH41JXZ'), true);
  assert.equal(isValidVin('ABC'), false);
});

test('Admin and GM can access any record', () => {
  assert.equal(canAccessRecord({ role: 'Admin' }, { ccmId: 'ccm-2' }), true);
  assert.equal(canAccessRecord({ role: 'GM' }, { ccmId: 'ccm-2' }), true);
});

test('CCM access is limited to their own team', () => {
  const actor = { id: 'ccm-1', role: 'CCM', ccmId: 'ccm-1' };
  assert.equal(canAccessRecord(actor, { ccmId: 'ccm-1' }), true);
  assert.equal(canAccessRecord(actor, { ccmId: 'ccm-2' }), false);
});

test('CRE access is limited to assigned records and same CCM', () => {
  const actor = { id: 'cre-1', role: 'CRE', ccmId: 'ccm-1' };
  assert.equal(canAccessRecord(actor, { ccmId: 'ccm-1', assigneeId: 'cre-1' }), true);
  assert.equal(canAccessRecord(actor, { ccmId: 'ccm-1', assigneeId: 'cre-2' }), false);
  assert.equal(canAccessRecord(actor, { ccmId: 'ccm-2', assigneeId: 'cre-1' }), false);
});

test('repair order import marks duplicate rows as skipped', () => {
  const existing = [buildDuplicateKey('1HGBH41JXZ', 'RO-1001')];
  const result = evaluateRow({ vin: '1hgbh41jxz', roNumber: 'RO-1001', ccmId: 'ccm-1', ownerCcmId: 'ccm-1' }, existing);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'Duplicate RO/VIN combination');
});

test('repair order import allows multiple repair orders for the same VIN', () => {
  const keys = new Set();
  const first = evaluateRow({
    vin: '1hgbh41jxz',
    roNumber: 'RO-1001',
    ccmId: 'ccm-1',
    ownerCcmId: 'ccm-1',
  }, keys);
  keys.add(buildDuplicateKey('1HGBH41JXZ', 'RO-1001'));
  const second = evaluateRow({
    vin: '1hgbh41jxz',
    roNumber: 'RO-1002',
    ccmId: 'ccm-1',
    ownerCcmId: 'ccm-1',
  }, keys);

  assert.equal(first.status, 'processed');
  assert.equal(second.status, 'processed');
});

test('cross-manager VIN conflict is flagged', () => {
  const result = evaluateRow({ vin: '1hgbh41jxz', roNumber: 'RO-1002', ccmId: 'ccm-1', ownerCcmId: 'ccm-2' }, []);

  assert.equal(result.status, 'flagged');
  assert.equal(result.reason, 'Cross-manager VIN conflict');
});

test('repair order import rejects a missing VIN but accepts a present short VIN', () => {
  const missing = evaluateRow({ vin: '', roNumber: 'RO-1003' }, []);
  const present = evaluateRow({ vin: 'BAD', roNumber: 'RO-1003' }, []);

  assert.equal(missing.status, 'rejected');
  assert.equal(missing.reason, 'Missing VIN');
  assert.equal(present.status, 'processed');
});

test('repair order import requires only repair order, VIN, and registration number', () => {
  assert.deepEqual(validateRepairOrderImportFields({
    roNumber: 'RO-1',
    vin: 'VIN-1',
    registrationNumber: 'REG-1',
  }), null);
  assert.equal(validateRepairOrderImportFields({
    roNumber: '',
    vin: 'VIN-1',
    registrationNumber: 'REG-1',
  }).code, 'MISSING_REPAIR_ORDER');
  assert.equal(validateRepairOrderImportFields({
    roNumber: 'RO-1',
    vin: '',
    registrationNumber: 'REG-1',
  }).code, 'MISSING_VIN');
  assert.equal(validateRepairOrderImportFields({
    roNumber: 'RO-1',
    vin: 'VIN-1',
    registrationNumber: '-',
  }).code, 'MISSING_REGISTRATION');
});

test('repair order import accepts required fields when customer and other optional fields are absent', () => {
  assert.equal(validateRepairOrderImportFields({
    roNumber: 'RO-1',
    vin: 'VIN-1',
    registrationNumber: 'REG-1',
    customerName: '',
    mobileNumber: '',
    visitDate: '',
    mileage: '',
  }), null);
});

test('repair order CSV parser recognizes rows without customer fields or a registration column', () => {
  const result = parseRepairOrderCsv([
    'Repair Order No,VIN,Model',
    'RO-1,VIN-1,',
  ].join('\n'));

  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.registrationNumber, undefined);
  assert.equal(result.rows[0].row.customerName, undefined);
});

test('cross-manager conflict helper works', () => {
  assert.equal(isCrossManagerConflict({ ccmId: 'ccm-1' }, 'ccm-2'), true);
  assert.equal(isCrossManagerConflict({ ccmId: 'ccm-1' }, 'ccm-1'), false);
});

test('repair-order duplicate rule accepts a Set for bulk import checks', () => {
  const keys = new Set([buildDuplicateKey('1HGBH41JXZ', 'RO-1001')]);
  const result = evaluateRow({ vin: '1hgbh41jxz', roNumber: 'RO-1001' }, keys);
  assert.equal(result.status, 'skipped');
});

test('call log validation requires a customer and supported outcome', () => {
  assert.equal(validateCallLogPayload({ outcome: 'CONTACTED' }).error, 'Customer ID is required.');
  assert.equal(validateCallLogPayload({ customerId: 'customer-1', outcome: 'unknown' }).error, 'Outcome is invalid.');
});

test('callback and follow-up-later call outcomes require a valid follow-up date', () => {
  assert.match(validateCallLogPayload({ customerId: 'customer-1', outcome: 'CALLBACK' }).error, /follow-up date is required/i);
  assert.match(validateCallLogPayload({ customerId: 'customer-1', outcome: 'FOLLOW_UP_LATER', followUpAt: 'not-a-date' }).error, /valid date/i);
});

test('valid call and follow-up payloads are normalized', () => {
  const call = validateCallLogPayload({
    customerId: ' customer-1 ',
    outcome: 'contacted',
    notes: ' spoke with customer ',
  });
  assert.equal(call.value.customerId, 'customer-1');
  assert.equal(call.value.outcome, 'CONTACTED');
  assert.equal(call.value.notes, 'spoke with customer');

  const followUp = validateFollowUpPayload({
    customerId: 'customer-1',
    category: 'Service reminder',
    followUpAt: '2026-10-13T10:00:00.000Z',
  });
  assert.equal(followUp.value.category, 'Service reminder');
  assert.equal(followUp.value.followUpAt.toISOString(), '2026-10-13T10:00:00.000Z');
});

test('customer validation requires a name and rejects invalid VINs', () => {
  assert.equal(validateCustomerPayload({ mobileNumber: '9876543210' }).error, 'Customer name is required.');
  assert.equal(validateCustomerPayload({ fullName: 'Asha', vehicles: [{ vin: 'BAD' }] }).error, 'Each vehicle must have a valid VIN.');
});

test('customer validation normalizes vehicles and rejects repeated VINs', () => {
  const result = validateCustomerPayload({
    fullName: ' Asha Menon ',
    email: ' ASHA@EXAMPLE.COM ',
    vehicles: [{ vin: '1hgbh41jxz', model: ' Creta ', year: 2024 }],
  });
  assert.equal(result.value.fullName, 'Asha Menon');
  assert.equal(result.value.email, 'asha@example.com');
  assert.equal(result.value.vehicles[0].vin, '1HGBH41JXZ');
  assert.equal(result.value.vehicles[0].model, 'Creta');

  assert.equal(validateCustomerPayload({
    fullName: 'Asha',
    vehicles: [{ vin: '1HGBH41JXZ' }, { vin: '1hgbh41jxz' }],
  }).error, 'A VIN can only be added once per customer.');
});

test('appointment validation requires customer and a future date', () => {
  assert.equal(validateAppointmentPayload({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }).error, 'Customer ID is required.');
  assert.match(validateAppointmentPayload({ customerId: 'customer-1', scheduledAt: 'invalid' }).error, /valid appointment date/i);
  assert.match(validateAppointmentPayload({ customerId: 'customer-1', scheduledAt: new Date(Date.now() - 60_000).toISOString() }).error, /future/i);
});

test('appointment validation normalizes valid booking payloads', () => {
  const result = validateAppointmentPayload({
    customerId: ' customer-1 ',
    vehicleId: ' vehicle-1 ',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    confirmationCall: true,
  });
  assert.equal(result.value.customerId, 'customer-1');
  assert.equal(result.value.vehicleId, 'vehicle-1');
  assert.equal(result.value.confirmationCall, true);
});

test('Free-Service CRE can book a customerless appointment without creating a customer record', () => {
  const date = new Date(Date.now() + 60_000).toISOString();
  assert.equal(validateAppointmentPayload({ customerName: 'Asha', scheduledAt: date }).error, 'Customer ID is required.');
  const result = validateAppointmentPayload(
    { customerName: ' Asha ', vehicleName: ' Creta ', scheduledAt: date },
    { allowCustomerless: true },
  );
  assert.equal(result.value.customerId, '');
  assert.equal(result.value.customerName, 'Asha');
  assert.equal(result.value.vehicleName, 'Creta');
  assert.equal(validateAppointmentPayload({ scheduledAt: date }, { allowCustomerless: true }).error, 'Customer name is required.');
});

test('Free-Service CRE appointment scope is own customerless appointments only', () => {
  assert.deepEqual(appointmentVisibilityWhere({
    id: 'free-cre-1',
    role: 'FREE_SERVICE_CRE',
    ccmId: 'ccm-1',
  }), {
    ccmId: 'ccm-1',
    createdById: 'free-cre-1',
    customerId: null,
  });
});

test('appointment updates accept only known statuses and nonempty changes', () => {
  assert.equal(validateAppointmentUpdate({}).error, 'At least one appointment field must be updated.');
  assert.equal(validateAppointmentUpdate({ status: 'booked' }).error, 'Appointment status is invalid.');
  assert.equal(validateAppointmentUpdate({ status: 'confirmed' }).value.status, 'CONFIRMED');
});

test('repair order CSV parser normalizes common headers and quoted values', () => {
  const result = parseRepairOrderCsv('Repair Order No,VIN,Customer Name,Phone,Model\nRO-1,1HGBH41JXZ,"Nair, Arun",9876543210,Creta');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.roNumber, 'RO-1');
  assert.equal(result.rows[0].row.customerName, 'Nair, Arun');
  assert.equal(result.rows[0].row.mobileNumber, '9876543210');
});

test('repair order CSV parser supports the service report export headers', () => {
  const result = parseRepairOrderCsv([
    'S NO,Repair Order No,R/O Date,Closing Date,G.P Date,Work Type,Status,Service Advisor,Vehicle VIN,Reg No,Model,Mileage,Sale Dealer,Sale Date,UC Sale Dealer,UC Sale Date,Customer Name,Address,E-mail,City,PIN,Mobile,Office,Tech.,Special Msg.,Visit Type,Demands',
    '1,RO-2026,02/05/2026,03/05/2026,04/05/2026,Running Repair,Delivered,Advisor,1HGBH41JXZ,KA01AB1234,Creta,3685,Dealer,07/11/2025,,,Customer,Park,customer@example.com,City,530014,9876543210,Office,Tech,Message,Periodic,Noise',
  ].join('\n'));

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.serialNo, '1');
  assert.equal(result.rows[0].row.roNumber, 'RO-2026');
  assert.equal(result.rows[0].row.visitDate, '02/05/2026');
  assert.equal(result.rows[0].row.workType, 'Running Repair');
  assert.equal(result.rows[0].row.serviceStatus, 'Delivered');
  assert.equal(result.rows[0].row.vin, '1HGBH41JXZ');
  assert.equal(result.rows[0].row.registrationNumber, 'KA01AB1234');
  assert.equal(result.rows[0].row.ucSaleDealer, '');
  assert.equal(result.rows[0].row.ucSaleDate, '');
  assert.equal(result.rows[0].row.address, 'Park');
  assert.equal(result.rows[0].row.email, 'customer@example.com');
  assert.equal(result.rows[0].row.city, 'City');
  assert.equal(result.rows[0].row.pin, '530014');
  assert.equal(result.rows[0].row.office, 'Office');
  assert.equal(result.rows[0].row.technician, 'Tech');
  assert.equal(result.rows[0].row.specialMessage, 'Message');
  assert.equal(Object.keys(result.rows[0].row).length, 27);
  assert.equal(result.rows[0].row.demands, 'Noise');
});

test('repair order CSV parser detects Hyundai grouped headings and maps the second header row', () => {
  const csv = [
    '\uFEFFS NO,Repair Order,,,,,,,,Vehicle,,,,,,,,Customer,,,,,,,,Special Ms,Visit Type,Demands',
    'S No,R/O No,R/O Date,Closing Date,G.P Date,Work Type,Status,Service Advisor,VIN,,Reg No,Model,Mileage,Sale Dealer,Sale Date,UC Sale Dealer,UC Sale Date,Name,Address,E-mail,City,PIN,Mobile,Office,Tech.,Special Msg.,Visit Type,Demands',
    '1,RO-1,01/02/2016,02/02/2016,20160201,Running Repair,Delivered,Advisor,1HGBH41JXZ,,KA01AB1234,Creta,3685,Dealer,20150507,,,Customer,"12 Main St, Suite ""A""",customer@example.com,City,530014,9876543210,Office,Tech,Message,Periodic,Noise',
    '2,RO-2,02/02/2016,03/02/2016,20160202,Paid Service,Delivered,Advisor,1HGBH41JXZ,,KA01AB1234,Creta,3690,Dealer,20150507,,,Customer,"13 Main St, Suite ""B""",customer@example.com,City,530014,9876543210,Office,Tech,Message,Periodic,Noise',
  ].join('\r\n');

  const result = parseRepairOrderCsv(csv);
  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].rowNumber, 3);
  assert.equal(result.rows[0].row.roNumber, 'RO-1');
  assert.equal(result.rows[0].row.visitDate, '01/02/2016');
  assert.equal(result.rows[0].row.gpDate, '20160201');
  assert.equal(result.rows[0].row.workType, 'Running Repair');
  assert.equal(result.rows[0].row.serviceStatus, 'Delivered');
  assert.equal(result.rows[0].row.vin, '1HGBH41JXZ');
  assert.equal(result.rows[0].row.registrationNumber, 'KA01AB1234');
  assert.equal(result.rows[0].row.customerName, 'Customer');
  assert.equal(result.rows[0].row.address, '12 Main St, Suite "A"');
  assert.equal(result.rows[0].row.email, 'customer@example.com');
  assert.equal(result.rows[0].row.pin, '530014');
  assert.equal(result.rows[0].row.mobileNumber, '9876543210');
  assert.equal(result.rows[0].row.technician, 'Tech');
  assert.equal(result.rows[1].row.roNumber, 'RO-2');
  assert.equal(result.rows[1].row.vin, result.rows[0].row.vin);
});

test('repair order CSV parser tolerates empty values, capitalization, whitespace, and blank header cells', () => {
  const result = parseRepairOrderCsv([
    'Repair Order,,VEHICLE,CUSTOMER',
    '  r / o no  , , Vehicle Vin ,  NAME  , Mobile',
    'RO-EMPTY,,1HGBH41JXZ, Customer Name ,',
  ].join('\n'));

  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.roNumber, 'RO-EMPTY');
  assert.equal(result.rows[0].row.vin, '1HGBH41JXZ');
  assert.equal(result.rows[0].row.customerName, 'Customer Name');
  assert.equal(result.rows[0].row.mobileNumber, '');
});

test('repair order CSV parser preserves the normalized one-header format', () => {
  const result = parseRepairOrderCsv([
    'Repair Order No,VIN,Customer Name,Phone,Model',
    'RO-1,1HGBH41JXZ,"Nair, Arun",9876543210,Creta',
  ].join('\n'));
  assert.equal(result.error, undefined);
  assert.equal(result.rows[0].row.roNumber, 'RO-1');
  assert.equal(result.rows[0].row.customerName, 'Nair, Arun');
  assert.equal(result.rows[0].row.mobileNumber, '9876543210');
  assert.equal(result.rows[0].row.model, 'Creta');
});

test('repair-order dates accept DD/MM/YYYY and YYYYMMDD while rejecting invalid calendar dates', () => {
  const dayFirst = parseRepairOrderDate('02/01/2016');
  const compact = parseRepairOrderDate('20160102');
  assert.equal(dayFirst.getFullYear(), 2016);
  assert.equal(dayFirst.getMonth(), 0);
  assert.equal(dayFirst.getDate(), 2);
  assert.equal(compact.getFullYear(), 2016);
  assert.equal(compact.getMonth(), 0);
  assert.equal(compact.getDate(), 2);
  assert.ok(Number.isNaN(parseRepairOrderDate('20160230')));
  assert.equal(parseRepairOrderDate(''), null);
});

test('repair order CSV parser rejects missing columns and malformed CSV', () => {
  assert.match(parseRepairOrderCsv('VIN,Customer Name\n1HGBH41JXZ,Nair').error, /missing required columns/i);
  assert.match(parseRepairOrderCsv('RO Number,VIN,Customer Name,Mobile\n"broken,1HGBH41JXZ,Nair,9876543210').error, /could not be parsed/i);
});

test('allocation validation requires vehicle, CRE, and service type', () => {
  assert.equal(validateAllocationPayload({ vehicleId: 'v1', creId: 'u1' }).error, 'Vehicle, CRE, and service type are required.');
});

test('allocation validation normalizes create and update fields', () => {
  const create = validateAllocationPayload({
    vehicleId: ' v1 ', creId: ' u1 ', serviceType: ' Annual Service ', notes: ' Call next week ',
  });
  assert.deepEqual(create.value, {
    vehicleId: 'v1', creId: 'u1', serviceType: 'Annual Service', category: null, notes: 'Call next week',
  });

  const update = validateAllocationUpdate({ creId: 'u2' });
  assert.deepEqual(update.value, { creId: 'u2', status: 'assigned' });
  assert.equal(validateAllocationUpdate({ status: 'open' }).error, 'Allocation status is invalid.');
});

test('monthly dataset period validates month and year bounds', () => {
  assert.deepEqual(validateDatasetPeriod(2026, 10).value, { year: 2026, month: 10 });
  assert.match(validateDatasetPeriod(1999, 10).error, /year/i);
  assert.match(validateDatasetPeriod(2026, 13).error, /month/i);
});

test('monthly customer rows validate and normalize linked vehicle fields', () => {
  const result = validateMonthlyCustomerRow({
    customerName: ' Asha Menon ',
    mobileNumber: '+91 98765 43210',
    email: ' ASHA@EXAMPLE.COM ',
    vin: '1hgbh41jxz',
    registrationNumber: 'ka01ab1234',
    year: '2024',
  });
  assert.equal(result.value.customerName, 'Asha Menon');
  assert.equal(result.value.mobileNumber, '+91 98765 43210');
  assert.equal(result.value.email, 'asha@example.com');
  assert.equal(result.value.vin, '1HGBH41JXZ');
  assert.equal(result.value.registrationNumber, 'KA01AB1234');
  assert.equal(result.value.vehicleYear, 2024);
  assert.equal(validateMonthlyCustomerRow({ customerName: 'Asha', mobileNumber: '123' }).error, 'A valid customer mobile number is required.');
});

test('monthly import classifies invalid and repeated records without overwriting history', () => {
  const result = classifyMonthlyRows([
    { rowNumber: 2, row: { customerName: 'Asha', mobileNumber: '9876543210', vin: '1HGBH41JXZ' } },
    { rowNumber: 3, row: { customerName: 'Asha duplicate', mobileNumber: '9876543210', vin: '1HGBH41JXZ' } },
    { rowNumber: 4, row: { customerName: '', mobileNumber: '9876543210' } },
  ]);
  assert.equal(result.addedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.rejectedCount, 1);
});

test('monthly CSV parser accepts normalized required customer headers', async () => {
  const result = await parseMonthlyCustomerDataFile({
    fileName: 'october.csv',
    content: 'Customer Name,Phone,VIN,Model\nAsha Menon,9876543210,1HGBH41JXZ,Creta',
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.customerName, 'Asha Menon');
  assert.equal(result.rows[0].row.mobileNumber, '9876543210');
  assert.equal(result.rows[0].row.vin, '1HGBH41JXZ');
});

test('monthly XLSX parser reads workbook values and normalizes headers', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('October');
  worksheet.addRow(['Customer Name', 'Mobile', 'VIN']);
  worksheet.addRow(['Asha Menon', '9876543210', '1HGBH41JXZ']);
  const bytes = await workbook.xlsx.writeBuffer();
  const result = await parseMonthlyCustomerDataFile({ fileName: 'october.xlsx', content: Buffer.from(bytes).toString('base64') });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.customerName, 'Asha Menon');
  assert.equal(result.rows[0].row.mobileNumber, '9876543210');
});

test('managed account usernames normalize and validate independently of email', () => {
  assert.equal(normalizeUsername('  New.CRE_1 '), 'new.cre_1');
  assert.equal(isValidUsername('new.cre_1'), true);
  assert.equal(isValidUsername('cre@service'), true);
  assert.equal(isValidUsername('cre@team'), true);
  assert.equal(isValidUsername('x'), false);
  assert.equal(isValidUsername('@cre'), false);
  assert.equal(validateOptionalPhone('').value, null);
  assert.equal(validateOptionalPhone('+1 212 555 0100').value, '+1 212 555 0100');
  assert.match(validateOptionalPhone('12').error, /7 to 15 digits/i);
});

test('CCM monthly data is shared only with that CCM and its assigned CRE', () => {
  assert.equal(canAccessCcmMonthlyData({ role: 'CCM', ccmId: 'ccm-a' }, 'ccm-a'), true);
  assert.equal(canAccessCcmMonthlyData({ role: 'CRE', ccmId: 'ccm-a' }, 'ccm-a'), true);
  assert.equal(canAccessCcmMonthlyData({ role: 'CCM', ccmId: 'ccm-a' }, 'ccm-b'), false);
  assert.equal(canAccessCcmMonthlyData({ role: 'CRE', ccmId: 'ccm-a' }, 'ccm-b'), false);
  assert.equal(canAccessCcmMonthlyData({ role: 'CRE', ccmId: null }, 'ccm-a'), false);
  assert.equal(canAccessCcmMonthlyData({ role: 'Admin' }, 'ccm-b'), true);
});
