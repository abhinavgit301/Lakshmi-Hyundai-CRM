import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { getCustomers, getDashboardSummary, getVisibilityWhere, loadCallListRecords, operationalReadScope } from '../src/controllers/recordsController.js';
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
    const visits = query.include.vehicle.include.physicalVehicle.include.workshopVisits;
    assert.deepEqual(visits.where, {});
    assert.deepEqual(visits.orderBy, latestWorkshopVisitOrderBy);
    assert.equal(visits.take, undefined);
  }

  const ccmQuery = await captureCallListQuery({ role: 'CCM', ccmId: 'ccm-a' });
  assert.deepEqual(ccmQuery.where, { ccmId: 'ccm-a' });
  assert.equal(ccmQuery.take, 100);
  const ccmVisits = ccmQuery.include.vehicle.include.physicalVehicle.include.workshopVisits;
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
    ccmQuery.include.vehicle.include.monthlyDataEntries.where.dataset.is,
    { ccmId: 'ccm-a' },
  );

  const creQuery = await captureCallListQuery({ role: 'CRE', id: 'cre-a1', ccmId: 'ccm-a' });
  assert.deepEqual(creQuery.where, { ccmId: 'ccm-a', ownerUserId: 'cre-a1' });
  assert.equal(creQuery.take, 100);
  const creVisits = creQuery.include.vehicle.include.physicalVehicle.include.workshopVisits;
  assert.deepEqual(creVisits.orderBy, latestWorkshopVisitOrderBy);
  assert.deepEqual(creVisits.where.physicalVehicle.is.vehicles.some.OR[0], {
    allocations: { some: { creId: 'cre-a1', ccmId: 'ccm-a', status: 'assigned' } },
  });
  assert.deepEqual(
    creQuery.include.vehicle.include.monthlyDataEntries.where.dataset.is,
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

async function captureCustomerQuery(user) {
  const original = prisma.customer.findMany;
  let captured;
  prisma.customer.findMany = async (args) => {
    captured = args;
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
