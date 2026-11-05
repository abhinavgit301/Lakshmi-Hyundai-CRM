import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { getCallList, getCustomerById, getCustomers, getDashboardSummary, getVisibilityWhere, loadCallListRecords, operationalReadScope } from '../src/controllers/recordsController.js';
import { getCrePerformanceSummary } from '../src/controllers/callWorkflowController.js';
import { getCreCallCounts } from '../src/utils/callMetrics.js';
import { workshopDayRange } from '../src/utils/workshopTime.js';
import { latestWorkshopVisitOrderBy } from '../src/utils/workshopVisitOrdering.js';

async function captureCallListQuery(user) {
  const original = prisma.masterCallList.findMany;
  let captured;
  prisma.masterCallList.findMany = async (args) => {
    captured = args;
    return [];
  };
  try {
    await loadCallListRecords(getVisibilityWhere(user), new Date('2026-01-15T12:00:00Z'), user);
  } finally {
    prisma.masterCallList.findMany = original;
  }
  return captured;
}

test('Master Call List loader scopes nested workshop history by role and preserves Admin/GM cross-CCM access', async () => {
  for (const role of ['ADMIN', 'GM']) {
    const query = await captureCallListQuery({ role });
    assert.deepEqual(query.where, {});
    assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.equal(query.take, 100);
    const visits = query.select.vehicle.select.physicalVehicle.select.workshopVisits;
    assert.deepEqual(visits.where, {});
    assert.deepEqual(visits.orderBy, latestWorkshopVisitOrderBy);
    assert.equal(visits.take, undefined);
    assert.deepEqual(Object.keys(query.select.vehicle.select.customer.select), ['appointments']);
    assert.equal(query.select.vehicle.select.customer.select.appointments.take, 1);
    assert.equal(query.include, undefined);
  }

  const ccmQuery = await captureCallListQuery({ role: 'CCM', ccmId: 'ccm-a' });
  assert.deepEqual(ccmQuery.where, { ccmId: 'ccm-a' });
  assert.equal(ccmQuery.take, 100);
  const ccmVisits = ccmQuery.select.vehicle.select.physicalVehicle.select.workshopVisits;
  assert.deepEqual(ccmVisits.where, {
    physicalVehicle: { is: { vehicles: { some: { ccmId: 'ccm-a' } } } },
  });
  assert.deepEqual(ccmVisits.orderBy, [
    { visitDate: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
    { id: 'desc' },
  ]);
  assert.equal(ccmVisits.take, undefined);
  assert.deepEqual(
    ccmQuery.select.vehicle.select.monthlyDataEntries.where.dataset.is,
    { ccmId: 'ccm-a' },
  );

  const creQuery = await captureCallListQuery({ role: 'CRE', id: 'cre-a1', ccmId: 'ccm-a' });
  assert.deepEqual(creQuery.where, { ccmId: 'ccm-a', ownerUserId: 'cre-a1' });
  assert.equal(creQuery.take, 100);
  const creVisits = creQuery.select.vehicle.select.physicalVehicle.select.workshopVisits;
  assert.deepEqual(creVisits.orderBy, latestWorkshopVisitOrderBy);
  assert.deepEqual(creVisits.where.physicalVehicle.is.vehicles.some.OR[0], {
    allocations: { some: { creId: 'cre-a1', ccmId: 'ccm-a', status: 'assigned' } },
  });
  assert.deepEqual(
    creQuery.select.vehicle.select.monthlyDataEntries.where.dataset.is,
    { ccmId: 'ccm-a' },
  );
});

test('Master Call List loader reads large histories in stable bounded chunks and bounds owner lookups', async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    id: `mcl-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    ccmId: 'ccm-a',
    ownerUserId: `owner-${index}`,
    customerName: `Customer ${index}`,
    mobileNumber: '',
    vin: `VIN-${index}`,
    status: 'pending',
    vehicle: null,
  })).sort((left, right) => right.createdAt - left.createdAt);
  const callListQueries = [];
  const ownerQueries = [];
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  prisma.masterCallList.findMany = async (args) => {
    callListQueries.push(args);
    let remainingRows = rows;
    const cursorClause = args.where?.AND?.[1];
    if (cursorClause) {
      const [olderThan, sameDate] = cursorClause.OR;
      const dateCursor = olderThan.createdAt.lt;
      const idCursor = sameDate.id.lt;
      remainingRows = rows.filter((row) => row.createdAt < dateCursor
        || (row.createdAt.getTime() === sameDate.createdAt.getTime() && row.id < idCursor));
    }
    return remainingRows.slice(0, args.take);
  };
  prisma.user.findMany = async (args) => {
    ownerQueries.push(args);
    return [];
  };

  try {
    const result = await loadCallListRecords({}, new Date('2026-01-15T12:00:00Z'), { role: 'ADMIN' });

    assert.equal(result.length, rows.length);
    assert.equal(callListQueries.length, 6);
    assert.ok(callListQueries.every(({ take }) => take === 100));
    assert.equal(callListQueries[0].where.OR, undefined);
    assert.deepEqual(callListQueries[1].where.AND[1].OR[0].createdAt.lt, rows[99].createdAt);
    assert.equal(ownerQueries.length, 2);
    assert.deepEqual(ownerQueries.map(({ where }) => where.id.in.length), [500, 1]);
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

test('Master Call List loader consolidates duplicate VINs across chunks before returning canonical rows', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: `mcl-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)),
    ccmId: 'ccm-a',
    ownerUserId: index === 100 ? 'assigned-cre' : index === 0 ? null : `owner-${index}`,
    customerName: `Customer ${index}`,
    mobileNumber: '',
    vin: index === 0 || index === 100 ? 'SHARED-VIN' : `VIN-${index}`,
    status: 'pending',
    vehicle: null,
  }));
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  prisma.masterCallList.findMany = async (args) => {
    let remainingRows = rows;
    const cursorClause = args.where?.AND?.[1];
    if (cursorClause) {
      const [olderThan, sameDate] = cursorClause.OR;
      const dateCursor = olderThan.createdAt.lt;
      const idCursor = sameDate.id.lt;
      remainingRows = rows.filter((row) => row.createdAt < dateCursor
        || (row.createdAt.getTime() === sameDate.createdAt.getTime() && row.id < idCursor));
    }
    return remainingRows.slice(0, args.take);
  };
  prisma.user.findMany = async ({ where }) => where.id.in.includes('assigned-cre')
    ? [{ id: 'assigned-cre', name: 'Assigned CRE' }]
    : [];

  try {
    const records = await loadCallListRecords({}, new Date('2026-01-15T12:00:00Z'), { role: 'ADMIN' });
    const sharedVinRows = records.filter(({ vin }) => vin === 'SHARED-VIN');

    assert.equal(sharedVinRows.length, 1);
    assert.equal(sharedVinRows[0].id, 'mcl-100');
    assert.equal(sharedVinRows[0].assigneeName, 'Assigned CRE');
    assert.equal(records.length, 100);
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

test('paginated Master Call List response retains exact page metadata and ordering', async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `mcl-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 3 - index)),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: `Customer ${index}`,
    mobileNumber: '',
    vin: `VIN-${index}`,
    status: 'pending',
    vehicle: null,
  }));
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  prisma.masterCallList.findMany = async ({ take }) => rows.slice(0, take);
  prisma.user.findMany = async () => [];
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await getCallList({ user: { role: 'ADMIN' }, query: { limit: '1', offset: '1' } }, res);

    assert.equal(res.body.records.length, 1);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.limit, 1);
    assert.equal(res.body.offset, 1);
    assert.equal(res.body.hasMore, true);
    assert.equal(res.body.records[0].id, 'mcl-1');
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

test('Master Call List response keeps a 48k-row result set to the requested page', async () => {
  const rows = Array.from({ length: 48048 }, (_, index) => ({
    id: `mcl-${String(index).padStart(5, '0')}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: `Customer ${index}`,
    mobileNumber: '',
    vin: index === 100 ? 'VIN-0' : `VIN-${index}`,
    status: 'pending',
    vehicle: null,
  }));
  const queryCalls = [];
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  prisma.masterCallList.findMany = async (args) => {
    queryCalls.push(args);
    let remainingRows = rows;
    const cursorClause = args.where?.AND?.[1];
    if (cursorClause) {
      const [olderThan, sameDate] = cursorClause.OR;
      const dateCursor = olderThan.createdAt.lt;
      const idCursor = sameDate.id.lt;
      remainingRows = rows.filter((row) => row.createdAt < dateCursor
        || (row.createdAt.getTime() === sameDate.createdAt.getTime() && row.id < idCursor));
    }
    return remainingRows.slice(0, args.take);
  };
  prisma.user.findMany = async () => [];
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await getCallList({ user: { role: 'ADMIN' }, query: {} }, res);

    assert.equal(res.body.records.length, 50);
    assert.equal(res.body.total, 48047);
    assert.equal(res.body.limit, 50);
    assert.equal(res.body.offset, 0);
    assert.equal(res.body.hasMore, true);
    assert.equal(queryCalls.length, 481);
    assert.ok(queryCalls.every(({ take }) => take <= 100));
    assert.equal(res.body.records[0].id, 'mcl-00001');
    assert.ok(!res.body.records.some((record) => record.id === 'mcl-00000' || record.id === 'mcl-00100'));
    assert.ok(res.body.records.every((record) => record.workshopVisits.length === 0));
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

test('paginated Master Call List preserves CCM allocation queue rows', async () => {
  const masterRow = {
    id: 'mcl-assigned-queue',
    createdAt: new Date('2026-01-03T00:00:00Z'),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: 'Existing customer',
    mobileNumber: '',
    vin: 'VIN-EXISTING',
    status: 'pending',
    vehicle: null,
  };
  const allocations = [
    {
      id: 'allocation-existing',
      ccmId: 'ccm-a',
      serviceType: 'Paid',
      vehicle: { id: 'vehicle-existing', vin: 'VIN-EXISTING', model: 'Model A', registrationNumber: 'REG-A', customer: null },
    },
    {
      id: 'allocation-only',
      ccmId: 'ccm-a',
      serviceType: 'Free',
      vehicle: { id: 'vehicle-only', vin: 'VIN-ONLY', model: 'Model B', registrationNumber: 'REG-B', customer: null },
    },
  ];
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  const originalAllocationFindMany = prisma.allocation.findMany;
  prisma.masterCallList.findMany = async () => [masterRow];
  prisma.user.findMany = async () => [];
  prisma.allocation.findMany = async () => allocations;

  const createResponse = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  try {
    const firstPage = createResponse();
    await getCallList({ user: { role: 'CCM', ccmId: 'ccm-a' }, query: { limit: '1', offset: '0' } }, firstPage);
    assert.equal(firstPage.body.total, 2);
    assert.equal(firstPage.body.records[0].id, masterRow.id);
    assert.equal(firstPage.body.records[0].allocationQueue, true);
    assert.equal(firstPage.body.hasMore, true);

    const secondPage = createResponse();
    await getCallList({ user: { role: 'CCM', ccmId: 'ccm-a' }, query: { limit: '1', offset: '1' } }, secondPage);
    assert.equal(secondPage.body.records[0].id, 'allocation:allocation-only');
    assert.equal(secondPage.body.records[0].allocationOnly, true);
    assert.equal(secondPage.body.hasMore, false);
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
    prisma.allocation.findMany = originalAllocationFindMany;
  }
});

test('paginated Master Call List still searches repair-order numbers in visit history', async () => {
  const row = {
    id: 'mcl-ro-search',
    createdAt: new Date('2026-01-03T00:00:00Z'),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: 'Repair history customer',
    mobileNumber: '',
    vin: 'VIN-RO',
    status: 'pending',
    vehicle: {
      id: 'vehicle-ro',
      customerId: 'customer-ro',
      model: 'Model',
      physicalVehicleId: 'physical-ro',
      physicalVehicle: {
        workshopVisits: [{
          id: 'visit-ro',
          repairOrderNo: 'RO-SEARCH-42',
          ccmId: null,
          visitDate: new Date('2025-01-01T00:00:00Z'),
          importedDetails: { roNumber: 'RO-SEARCH-42' },
        }],
      },
      allocations: [],
      monthlyDataEntries: [],
      appointments: [],
      customer: { appointments: [] },
    },
  };
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  prisma.masterCallList.findMany = async () => [row];
  prisma.user.findMany = async () => [];
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await getCallList({ user: { role: 'ADMIN' }, query: { search: 'RO-SEARCH-42' } }, res);

    assert.equal(res.body.total, 1);
    assert.equal(res.body.records[0].id, row.id);
    assert.deepEqual(res.body.records[0].workshopVisits, []);
    assert.equal(res.body.records[0].importedDetails, null);
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

test('Master Call List mobile falls back to the imported service-history value', async () => {
  const originalMasterFindMany = prisma.masterCallList.findMany;
  const originalUserFindMany = prisma.user.findMany;
  prisma.masterCallList.findMany = async () => [{
    id: 'mcl-mobile',
    createdAt: new Date('2026-01-15T12:00:00Z'),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: 'Imported Customer',
    mobileNumber: '-',
    vin: 'VIN-MOBILE',
    status: 'pending',
    vehicle: {
      physicalVehicle: {
        workshopVisits: [{
          id: 'visit-mobile',
          ccmId: 'ccm-a',
          importedDetails: { mobileNumber: '5550100' },
        }],
      },
      monthlyDataEntries: [],
      allocations: [],
      appointments: [],
      customer: { appointments: [] },
    },
  }];
  prisma.user.findMany = async () => [];

  try {
    const records = await loadCallListRecords({}, new Date('2026-01-15T12:00:00Z'), { role: 'ADMIN' });
    assert.equal(records[0].mobile, '5550100');
  } finally {
    prisma.masterCallList.findMany = originalMasterFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

async function captureCustomerQuery(user) {
  const original = prisma.customer.findMany;
  let captured;
  prisma.customer.findMany = async (args) => {
    if (args.select) return [{ id: 'customer-1' }];
    captured = { ...args, where: args.where.AND[0], idFilter: args.where.AND[1] };
    return [];
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await getCustomers({ user }, res);
  } finally {
    prisma.customer.findMany = original;
  }
  return { query: captured, response: res };
}

test('Customer endpoint scopes nested vehicles and related records by role', async () => {
  for (const role of ['ADMIN', 'GM']) {
    const unrestricted = await captureCustomerQuery({ role });
    assert.deepEqual(unrestricted.query.where, {});
    assert.equal(unrestricted.query.include.vehicles.where, undefined);
    assert.deepEqual(unrestricted.query.include.vehicles.include.allocations.where, {});
  }

  const ccm = await captureCustomerQuery({ role: 'CCM', ccmId: 'ccm-a' });
  assert.deepEqual(ccm.query.where, {
    OR: [
      { ccmId: 'ccm-a' },
      { vehicles: { some: { ccmId: 'ccm-a' } } },
    ],
  });

  assert.deepEqual(ccm.query.include.vehicles.where, { ccmId: 'ccm-a' });
  assert.deepEqual(ccm.query.include.visits.where, {
    physicalVehicle: { is: { vehicles: { some: { ccmId: 'ccm-a' } } } },
  });
  assert.deepEqual(ccm.query.include.vehicles.include.allocations.where, { ccmId: 'ccm-a' });

  const ccmWithoutId = await captureCustomerQuery({ role: 'CCM' });
  assert.deepEqual(ccmWithoutId.query.where, {
    OR: [
      { ccmId: 'no-access' },
      { vehicles: { some: { ccmId: 'no-access' } } },
    ],
  });
  assert.deepEqual(ccmWithoutId.query.include.vehicles.where, { ccmId: 'no-access' });
  assert.deepEqual(ccmWithoutId.query.include.vehicles.include.allocations.where, { ccmId: 'no-access' });

  const cre = await captureCustomerQuery({ role: 'CRE', id: 'cre-a1', ccmId: 'ccm-a' });
  assert.equal(cre.query.where.vehicles.some.ccmId, 'ccm-a');
  assert.deepEqual(cre.query.include.visits.where, {
    physicalVehicle: {
      is: {
        vehicles: {
          some: {
            ccmId: 'ccm-a',
            OR: [
              { allocations: { some: { creId: 'cre-a1', ccmId: 'ccm-a', status: 'assigned' } } },
              { masterCallListEntries: { some: { ownerUserId: 'cre-a1', ccmId: 'ccm-a' } } },
            ],
          },
        },
      },
    },
  });
  assert.equal(cre.query.include.vehicles.where.OR[0].allocations.some.status, 'assigned');
  assert.equal(cre.query.include.vehicles.include.allocations.where.creId, 'cre-a1');
  assert.equal(cre.query.include.vehicles.include.allocations.where.ccmId, 'ccm-a');

  const creWithoutCcmId = await captureCustomerQuery({ role: 'CRE', id: 'cre-a1' });
  assert.equal(creWithoutCcmId.query.include.vehicles.where.OR[0].allocations.some.ccmId, 'no-access');
  assert.equal(creWithoutCcmId.query.include.vehicles.include.allocations.where.ccmId, 'no-access');
});

test('customer profile uses saved contact fields and falls back to imported service history', async () => {
  const originalCustomerFindMany = prisma.customer.findMany;
  const originalUserFindMany = prisma.user.findMany;
  const customerRows = [
    {
      id: 'customer-mobile',
      fullName: 'Imported Customer',
      mobileNumber: null,
      ccmId: 'ccm-a',
      email: null,
      address: null,
      city: null,
      pin: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      vehicles: [],
      visits: [{
        id: 'visit-mobile',
        vehicleId: null,
        repairOrderNo: 'RO-MOBILE',
        ccmId: 'ccm-a',
        visitDate: new Date('2026-01-15T00:00:00Z'),
        createdAt: new Date('2026-01-15T00:00:00Z'),
        importedDetails: {
          mobileNumber: '5550100',
          address: '12 Main Road',
          city: 'Visakhapatnam',
          pin: '530046',
        },
      }],
    },
    {
      id: 'customer-saved-contact',
      fullName: 'Saved Contact',
      mobileNumber: '5550200',
      ccmId: 'ccm-a',
      email: 'saved@example.com',
      address: 'Saved address',
      city: 'Saved city',
      pin: '100001',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      vehicles: [],
      visits: [{
        id: 'visit-old-contact',
        vehicleId: null,
        repairOrderNo: 'RO-OLD-CONTACT',
        ccmId: 'ccm-a',
        visitDate: new Date('2026-01-15T00:00:00Z'),
        createdAt: new Date('2026-01-15T00:00:00Z'),
        importedDetails: {
          address: 'Old imported address',
          city: 'Old imported city',
          pin: '200002',
        },
      }],
    },
  ];
  prisma.customer.findMany = async (args) => (args.select
    ? customerRows.map(({ id }) => ({ id }))
    : customerRows.filter(({ id }) => args.where.AND[1].id.in.includes(id)));
  prisma.user.findMany = async () => [];
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await getCustomers({ user: { role: 'ADMIN' } }, res);
    assert.equal(res.body.customers[0].mobile, '5550100');
    assert.equal(res.body.customers[0].address, '12 Main Road');
    assert.equal(res.body.customers[0].city, 'Visakhapatnam');
    assert.equal(res.body.customers[0].pin, '530046');
    assert.equal(res.body.customers[1].address, 'Saved address');
    assert.equal(res.body.customers[1].city, 'Saved city');
    assert.equal(res.body.customers[1].pin, '100001');
  } finally {
    prisma.customer.findMany = originalCustomerFindMany;
    prisma.user.findMany = originalUserFindMany;
  }
});

test('Customer endpoint loads relations in bounded batches and preserves order and scope', async () => {
  const original = prisma.customer.findMany;
  const originalUser = prisma.user.findMany;
  const total = 1250;
  const ids = Array.from({ length: total }, (_, index) => `customer-${index}`);
  const detailCalls = [];
  prisma.customer.findMany = async (args) => {
    if (args.select) return [...ids, ids[0]].map((id) => ({ id }));
    detailCalls.push(args);
    // Return in reverse order to prove the controller restores the id-query order.
    return [...args.where.AND[1].id.in].reverse().map((id) => ({
      id, fullName: id, mobileNumber: null, ccmId: 'ccm-a', vehicles: [], visits: [],
    }));
  };
  prisma.user.findMany = async () => [];
  const res = { status() { return this; }, json(body) { this.body = body; return this; } };
  try {
    await getCustomers({ user: { role: 'CCM', ccmId: 'ccm-a' } }, res);
  } finally {
    prisma.customer.findMany = original;
    prisma.user.findMany = originalUser;
  }
  assert.equal(detailCalls.length, 3);
  for (const call of detailCalls) {
    assert.ok(call.where.AND[1].id.in.length <= 500);
    assert.deepEqual(call.where.AND[0].OR[0], { ccmId: 'ccm-a' });
  }
  assert.deepEqual(res.body.customers.map((customer) => customer.id), ids);
});

test('Customer endpoint splits a batch and retries when Prisma reports P2029', async () => {
  const original = prisma.customer.findMany;
  const originalUser = prisma.user.findMany;
  const ids = Array.from({ length: 7 }, (_, index) => `customer-${index}`);
  const detailSizes = [];
  prisma.customer.findMany = async (args) => {
    if (args.select) return ids.map((id) => ({ id }));
    const requested = args.where.AND[1].id.in;
    detailSizes.push(requested.length);
    if (requested.length > 2) throw Object.assign(new Error('limit'), { code: 'P2029' });
    return [...requested].reverse().map((id) => ({ id, fullName: id, mobileNumber: null, ccmId: 'ccm-a', vehicles: [], visits: [] }));
  };
  prisma.user.findMany = async () => [];
  const res = { status() { return this; }, json(body) { this.body = body; return this; } };
  try {
    await getCustomers({ user: { role: 'ADMIN' } }, res);
    assert.deepEqual(res.body.customers.map((customer) => customer.id), ids);
    assert.ok(detailSizes.every((size, index) => size <= 7 && (index === 0 || size < 7)));

    prisma.customer.findMany = async (args) => {
      if (args.select) return [{ id: 'only' }];
      throw Object.assign(new Error('limit'), { code: 'P2029' });
    };
    await assert.rejects(() => getCustomers({ user: { role: 'ADMIN' } }, res), { code: 'P2029' });

    prisma.customer.findMany = async (args) => {
      if (args.select) return [];
      throw new Error('detail query must not run for empty results');
    };
    await getCustomers({ user: { role: 'ADMIN' } }, res);
    assert.deepEqual(res.body.customers, []);
  } finally {
    prisma.customer.findMany = original;
    prisma.user.findMany = originalUser;
  }
});

test('Customer list is slim while the single-customer endpoint keeps full repair history', async () => {
  const original = prisma.customer.findMany;
  const originalUser = prisma.user.findMany;
  const visit = {
    id: 'visit-1', vehicleId: 'vehicle-1', repairOrderNo: 'RO-1', ccmId: 'ccm-a',
    visitDate: new Date('2026-01-10T00:00:00Z'), createdAt: new Date('2026-01-10T00:00:00Z'),
    closingDate: null, gpDate: null, totalAmount: 10, importedDetails: { mobileNumber: '5550100', bulky: 'x'.repeat(500) },
  };
  const rowFor = (id) => ({
    id, fullName: id, mobileNumber: null, ccmId: 'ccm-a', createdAt: new Date('2026-01-01T00:00:00Z'),
    vehicles: [{ id: 'vehicle-1', saleDate: null, physicalVehicle: { id: 'pv-1', workshopVisits: [visit] }, allocations: [] }],
    visits: [visit],
  });
  const ids = Array.from({ length: 5 }, (_, index) => `customer-${index}`);
  const calls = [];
  const originalCount = prisma.customer.count;
  prisma.customer.count = async () => ids.length;
  prisma.customer.findMany = async (args) => {
    calls.push(args);
    if (args.select) {
      const start = args.skip ?? 0;
      return ids.slice(start, args.take === undefined ? undefined : start + args.take).map((id) => ({ id }));
    }
    return args.where.AND[1].id.in.map(rowFor);
  };
  prisma.user.findMany = async () => [{ ccmId: 'ccm-a', dealerCode: 'D1' }];
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await getCustomers({ user: { role: 'ADMIN' }, query: {} }, res);
    const [first] = res.body.customers;
    assert.equal(res.body.customers.length, 5);
    assert.equal(first.mobile, '5550100');
    assert.equal(first.visits[0].importedDetails, undefined);
    assert.equal(first.vehicles[0].physicalVehicle, undefined);
    assert.equal(first.vehicles[0].workshopVisits, undefined);
    assert.equal(first.visits.length, 1);
    assert.ok(!('total' in res.body));

    await getCustomers({ user: { role: 'ADMIN' }, query: { limit: '2', offset: '1' } }, res);
    assert.deepEqual(res.body.customers.map((customer) => customer.id), ['customer-1', 'customer-2']);
    assert.deepEqual([res.body.total, res.body.hasMore, res.body.offset], [5, true, 1]);

    await getCustomers({ user: { role: 'ADMIN' }, query: { limit: '999' } }, res);
    assert.equal(res.statusCode, 400);

    calls.length = 0;
    res.statusCode = 200;
    await getCustomerById({ user: { role: 'CCM', ccmId: 'ccm-a' }, params: { id: 'customer-3' } }, res);
    assert.equal(res.body.customer.id, 'customer-3');
    assert.equal(res.body.customer.visits[0].importedDetails.bulky.length, 500);
    assert.equal(res.body.customer.visits[0].dealerCode, 'D1');
    assert.equal(res.body.customer.vehicles[0].workshopVisits.length, 1);
    assert.deepEqual(calls[0].where.AND[1], { id: { in: ['customer-3'] } });
    assert.deepEqual(calls[0].where.AND[0].OR[0], { ccmId: 'ccm-a' });

    prisma.customer.findMany = async () => [];
    await getCustomerById({ user: { role: 'CRE', id: 'cre-1', ccmId: 'ccm-a' }, params: { id: 'other' } }, res);
    assert.equal(res.statusCode, 404);
    await getCustomerById({ user: { role: 'FREE_SERVICE_CRE' }, params: { id: 'x' } }, res);
    assert.equal(res.statusCode, 403);
  } finally {
    prisma.customer.findMany = original;
    prisma.customer.count = originalCount;
    prisma.user.findMany = originalUser;
  }
});

test('CCM and CRE operational dashboard scopes exclude cross-CCM and null-owned workflow records', () => {
  const ccmScope = operationalReadScope({ role: 'CCM', ccmId: 'ccm-a' });
  assert.equal(ccmScope.call.ccmId, 'ccm-a');
  assert.equal(ccmScope.followUp.ccmId, 'ccm-a');

  const creScope = operationalReadScope({ role: 'CRE', id: 'cre-a1', ccmId: 'ccm-a' });
  assert.equal(creScope.call.ccmId, 'ccm-a');
  assert.equal(creScope.followUp.ccmId, 'ccm-a');

  const followUps = [
    { id: 'a', ccmId: 'ccm-a' },
    { id: 'b', ccmId: 'ccm-b' },
    { id: 'legacy', ccmId: null },
  ];
  assert.deepEqual(followUps.filter((item) => item.ccmId === ccmScope.followUp.ccmId).map(({ id }) => id), ['a']);
  assert.deepEqual(followUps.filter((item) => item.ccmId === creScope.followUp.ccmId).map(({ id }) => id), ['a']);

  for (const role of ['ADMIN', 'GM']) {
    const scope = operationalReadScope({ role });
    assert.deepEqual(scope.call, {});
    assert.deepEqual(scope.followUp, {});
    assert.deepEqual(followUps.map(({ id }) => id), ['a', 'b', 'legacy']);
  }
});

test('CRE call metrics count only matching CCM-owned calls, excluding null ownership', async () => {
  const fixtureCalls = [
    { createdById: 'cre-a1', ccmId: 'ccm-a', outcome: 'CONTACTED' },
    { createdById: 'cre-a1', ccmId: 'ccm-b', outcome: 'CONTACTED' },
    { createdById: 'cre-a1', ccmId: null, outcome: 'CONTACTED' },
  ];
  const original = prisma.callLog.groupBy;
  let captured;
  prisma.callLog.groupBy = async (args) => {
    captured = args;
    return fixtureCalls
      .filter((call) => call.ccmId === args.where.ccmId && args.where.createdById.in.includes(call.createdById))
      .map((call) => ({ createdById: call.createdById, outcome: call.outcome, _count: { _all: 1 } }));
  };
  try {
    const counts = await getCreCallCounts({
      creIds: ['cre-a1'],
      ccmId: 'ccm-a',
      start: new Date('2026-10-30T00:00:00Z'),
      end: new Date('2026-10-31T00:00:00Z'),
    });
    assert.equal(captured.where.ccmId, 'ccm-a');
    assert.deepEqual(counts.get('cre-a1'), { callsMade: 1, callsPickedUp: 1 });
  } finally {
    prisma.callLog.groupBy = original;
  }
});

test('CCM call metrics count only their CCM calls and exclude cross-team and historical null ownership', async () => {
  const fixtureCalls = [
    { createdById: 'cre-a1', ccmId: 'ccm-a', outcome: 'CONTACTED' },
    { createdById: 'cre-a1', ccmId: 'ccm-b', outcome: 'CONTACTED' },
    { createdById: 'cre-a1', ccmId: null, outcome: 'CONTACTED' },
  ];
  const original = prisma.callLog.groupBy;
  let captured;
  prisma.callLog.groupBy = async (args) => {
    captured = args;
    return fixtureCalls
      .filter((call) => call.ccmId === args.where.ccmId && args.where.createdById.in.includes(call.createdById))
      .map((call) => ({ createdById: call.createdById, outcome: call.outcome, _count: { _all: 1 } }));
  };
  try {
    const counts = await getCreCallCounts({
      creIds: ['cre-a1'],
      ccmId: 'ccm-a',
      start: new Date('2026-10-30T00:00:00Z'),
      end: new Date('2026-10-31T00:00:00Z'),
    });
    assert.equal(captured.where.ccmId, 'ccm-a');
    assert.equal(counts.get('cre-a1').callsMade, 1);
  } finally {
    prisma.callLog.groupBy = original;
  }
});

test('Admin and GM call metrics remain cross-CCM and include historically null-owned calls', async () => {
  const original = prisma.callLog.groupBy;
  let captured;
  prisma.callLog.groupBy = async (args) => {
    captured = args;
    return [
      { createdById: 'cre-a1', outcome: 'CONTACTED', _count: { _all: 1 } },
      { createdById: 'cre-a1', outcome: 'CONTACTED', _count: { _all: 1 } },
      { createdById: 'cre-a1', outcome: 'CONTACTED', _count: { _all: 1 } },
    ];
  };
  try {
    for (const role of ['ADMIN', 'GM']) {
      const counts = await getCreCallCounts({
        creIds: ['cre-a1'],
        start: new Date('2026-10-30T00:00:00Z'),
        end: new Date('2026-10-31T00:00:00Z'),
      });
      assert.equal(Object.hasOwn(captured.where, 'ccmId'), false);
      assert.equal(counts.get('cre-a1').callsMade, 3, `${role} should retain cross-CCM and historical visibility`);
    }
  } finally {
    prisma.callLog.groupBy = original;
  }
});

test('Free-Service CRE dashboard metrics exclude null-owned and cross-CCM calls', async () => {
  const fixtureCalls = [
    { createdById: 'free-cre-a', ccmId: 'ccm-a', callSource: 'FREE_SERVICE', outcome: 'CONTACTED' },
    { createdById: 'free-cre-a', ccmId: 'ccm-b', callSource: 'FREE_SERVICE', outcome: 'CONTACTED' },
    { createdById: 'free-cre-a', ccmId: null, callSource: 'FREE_SERVICE', outcome: 'CONTACTED' },
  ];
  const originalGroupBy = prisma.callLog.groupBy;
  const originalAppointments = prisma.appointment.findMany;
  let captured;
  prisma.callLog.groupBy = async (args) => {
    captured = args;
    const calls = fixtureCalls.filter((call) => call.ccmId === args.where.ccmId
      && args.where.createdById.in.includes(call.createdById)
      && args.where.callSource.in.includes(call.callSource));
    return calls.map((call) => ({ createdById: call.createdById, outcome: call.outcome, _count: { _all: 1 } }));
  };
  prisma.appointment.findMany = async () => [];
  try {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getDashboardSummary({
      user: { id: 'free-cre-a', role: 'FREE_SERVICE_CRE', ccmId: 'ccm-a' },
    }, response);
    assert.equal(captured.where.ccmId, 'ccm-a');
    assert.equal(response.body.freeServiceCre.dailyTargets.callsMade.actual, 1);
    assert.equal(response.body.freeServiceCre.dailyTargets.callsPickedUp.actual, 1);
  } finally {
    prisma.callLog.groupBy = originalGroupBy;
    prisma.appointment.findMany = originalAppointments;
  }
});

test('CRE performance lifetime calls and pending follow-ups exclude cross-CCM and null-owned rows', async () => {
  const date = workshopDayRange().dateKey;
  const [year, month] = date.split('-').map(Number);
  const fixtureCalls = [
    { ccmId: 'ccm-a', createdById: 'cre-a1', callSource: 'SERVICE' },
    { ccmId: 'ccm-b', createdById: 'cre-a1', callSource: 'SERVICE' },
    { ccmId: null, createdById: 'cre-a1', callSource: 'SERVICE' },
  ];
  const fixtureFollowUps = [
    { ccmId: 'ccm-a', status: 'pending' },
    { ccmId: 'ccm-b', status: 'pending' },
    { ccmId: null, status: 'pending' },
  ];
  const originals = {
    callCount: prisma.callLog.count,
    callGroupBy: prisma.callLog.groupBy,
    callFindMany: prisma.callLog.findMany,
    followUpCount: prisma.followUp.count,
    appointmentCount: prisma.appointment.count,
    importFindFirst: prisma.monthlyCustomerDataImport.findFirst,
    masterListFindMany: prisma.masterCallList.findMany,
  };
  let lifetimeCallWhere;
  let followUpWhere;
  prisma.callLog.count = async ({ where }) => {
    lifetimeCallWhere = where;
    return fixtureCalls.filter((call) => call.ccmId === where.ccmId).length;
  };
  prisma.callLog.groupBy = async () => [];
  prisma.callLog.findMany = async () => [];
  prisma.followUp.count = async ({ where }) => {
    followUpWhere = where;
    return fixtureFollowUps.filter((followUp) => followUp.ccmId === where.ccmId).length;
  };
  prisma.appointment.count = async () => 0;
  prisma.monthlyCustomerDataImport.findFirst = async () => null;
  prisma.masterCallList.findMany = async () => [];
  try {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getCrePerformanceSummary({
      user: { id: 'cre-a1', name: 'CRE A1', role: 'CRE', ccmId: 'ccm-a' },
      query: { year: String(year), month: String(month), date },
    }, response);
    assert.equal(lifetimeCallWhere.ccmId, 'ccm-a');
    assert.equal(response.body.lifetimeCalls, 1);
    assert.equal(followUpWhere.ccmId, 'ccm-a');
    assert.equal(response.body.pendingFollowUps, 1);
  } finally {
    prisma.callLog.count = originals.callCount;
    prisma.callLog.groupBy = originals.callGroupBy;
    prisma.callLog.findMany = originals.callFindMany;
    prisma.followUp.count = originals.followUpCount;
    prisma.appointment.count = originals.appointmentCount;
    prisma.monthlyCustomerDataImport.findFirst = originals.importFindFirst;
    prisma.masterCallList.findMany = originals.masterListFindMany;
  }
});
