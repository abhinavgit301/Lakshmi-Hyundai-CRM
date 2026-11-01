import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedServiceSources,
  canAccessServiceSource,
  resolveCreServicePermissions,
} from '../src/utils/creServicePermissions.js';
import { callLogVisibility, createCallLog, createFollowUp, getCrePerformanceSummary, listFollowUps } from '../src/controllers/callWorkflowController.js';
import { isVehicleAssignedToCre, workshopVisitVisibilityWhere } from '../src/utils/creAccess.js';
import { getFreeServiceList, getWarrantyList } from '../src/controllers/serviceListsController.js';
import {
  getCallList,
  getCustomers,
  getVisibilityWhere,
  operationalReadScope,
  resolveMasterCallListVisibility,
} from '../src/controllers/recordsController.js';
import { listAllocations } from '../src/controllers/allocationController.js';
import { prisma } from '../src/config/prisma.js';
import {
  filterMasterCallListRecords,
  validateMasterCallListFilters,
} from '../src/utils/masterCallListFilters.js';

function mockRes() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const combinations = [
  { freeServiceEnabled: false, warrantyEnabled: false, expected: ['SERVICE'] },
  { freeServiceEnabled: true, warrantyEnabled: false, expected: ['SERVICE', 'FREE_SERVICE'] },
  { freeServiceEnabled: false, warrantyEnabled: true, expected: ['SERVICE', 'WARRANTY'] },
  { freeServiceEnabled: true, warrantyEnabled: true, expected: ['SERVICE', 'FREE_SERVICE', 'WARRANTY'] },
];

for (const combination of combinations) {
  test(`CRE permissions allow ${combination.expected.slice(1).join(' and ') || 'neither extra category'}`, () => {
    const user = { role: 'CRE', ...combination };
    assert.deepEqual(allowedServiceSources(user), combination.expected);
    assert.equal(canAccessServiceSource(user, 'FREE_SERVICE'), combination.freeServiceEnabled);
    assert.equal(canAccessServiceSource(user, 'WARRANTY'), combination.warrantyEnabled);
  });
}

test('existing CRE accounts with no permission fields remain restricted', () => {
  assert.deepEqual(allowedServiceSources({ role: 'CRE' }), ['SERVICE']);
});

test('CCM access remains unrestricted by CRE permissions', () => {
  const ccm = { role: 'CCM', freeServiceEnabled: false, warrantyEnabled: false };
  assert.deepEqual(allowedServiceSources(ccm), ['SERVICE', 'FREE_SERVICE', 'WARRANTY']);
  assert.equal(canAccessServiceSource(ccm, 'FREE_SERVICE'), true);
  assert.equal(canAccessServiceSource(ccm, 'WARRANTY'), true);
});

test('paginated follow-up search retains CCM visibility constraints and returns page metadata', async () => {
  const originalFindMany = prisma.followUp.findMany;
  const originalCount = prisma.followUp.count;
  let findArgs;
  let countArgs;
  prisma.followUp.findMany = async (args) => {
    findArgs = args;
    return [{ id: 'follow-up-2' }];
  };
  prisma.followUp.count = async (args) => {
    countArgs = args;
    return 3;
  };
  try {
    const res = mockRes();
    await listFollowUps({
      user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-a' },
      query: { source: 'SERVICE', search: 'VIN', limit: '1', offset: '1' },
    }, res);

    assert.deepEqual(findArgs.skip, 1);
    assert.deepEqual(findArgs.take, 1);
    assert.equal(findArgs.where.ccmId, 'ccm-a');
    assert.ok(Array.isArray(findArgs.where.OR));
    assert.ok(Array.isArray(findArgs.where.AND));
    assert.deepEqual(findArgs.where.AND[0].OR[0], { id: { contains: 'vin', mode: 'insensitive' } });
    assert.deepEqual(countArgs.where, findArgs.where);
    assert.deepEqual(res.body, {
      followUps: [{ id: 'follow-up-2' }],
      total: 3,
      limit: 1,
      offset: 1,
      hasMore: true,
    });
  } finally {
    prisma.followUp.findMany = originalFindMany;
    prisma.followUp.count = originalCount;
  }
});

test('Free-Service follow-up filters combine dates, milestone, assignee, and search inside CCM scope', async () => {
  const originalFindMany = prisma.followUp.findMany;
  const originalCount = prisma.followUp.count;
  let where;
  prisma.followUp.findMany = async (args) => {
    where = args.where;
    return [];
  };
  prisma.followUp.count = async (args) => args.where === where ? 0 : -1;
  try {
    const res = mockRes();
    await listFollowUps({
      user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-a' },
      query: {
        source: 'FREE_SERVICE',
        milestone: '2',
        graceStatus: 'grace',
        assigneeId: 'cre-a',
        saleFrom: '2024-01-01',
        saleTo: '2024-01-31',
        dueFrom: '2025-01-01',
        dueTo: '2025-01-31',
        followUpFrom: '2025-02-01',
        search: 'vin',
        limit: '10',
      },
    }, res);

    assert.equal(where.ccmId, 'ccm-a');
    assert.ok(Array.isArray(where.OR));
    assert.ok(where.AND.some((condition) => condition.creId === 'cre-a'));
    assert.ok(where.AND.some((condition) => condition.milestone?.is?.milestone === 2));
    assert.ok(where.AND.some((condition) => condition.milestone?.is?.dueDate?.gte instanceof Date
      && condition.milestone.is.dueDate.lt instanceof Date));
    assert.ok(where.AND.some((condition) => condition.vehicle?.is?.saleDate?.gte instanceof Date));
    assert.ok(where.AND.some((condition) => condition.milestone?.is?.dueDate?.gte instanceof Date));
    assert.ok(where.AND.some((condition) => condition.followUpAt?.gte instanceof Date));
    assert.ok(where.AND.some((condition) => condition.OR?.some((searchCondition) => searchCondition.vehicle?.is?.vin)));
    assert.deepEqual(res.body.followUps, []);
  } finally {
    prisma.followUp.findMany = originalFindMany;
    prisma.followUp.count = originalCount;
  }
});

test('Warranty expiry follow-up date filters invert the calendar-month rule exactly', async () => {
  const originalFindMany = prisma.followUp.findMany;
  const originalCount = prisma.followUp.count;
  let where;
  prisma.followUp.findMany = async (args) => {
    where = args.where;
    return [];
  };
  prisma.followUp.count = async () => 0;
  try {
    const res = mockRes();
    await listFollowUps({
      user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-a' },
      query: {
        source: 'WARRANTY',
        expiryFrom: '2027-02-28',
        expiryTo: '2027-02-28',
        limit: '10',
      },
    }, res);

    const saleDateRange = where.AND.find((condition) => condition.vehicle?.is?.saleDate)?.vehicle.is.saleDate;
    assert.equal(saleDateRange.gte.getFullYear(), 2024);
    assert.equal(saleDateRange.gte.getMonth(), 1);
    assert.equal(saleDateRange.gte.getDate(), 28);
    assert.equal(saleDateRange.lt.getFullYear(), 2024);
    assert.equal(saleDateRange.lt.getMonth(), 2);
    assert.equal(saleDateRange.lt.getDate(), 1);
  } finally {
    prisma.followUp.findMany = originalFindMany;
    prisma.followUp.count = originalCount;
  }
});

test('Warranty follow-up contact-status filtering applies expiry timing before pagination', async () => {
  const originalFollowUpFindMany = prisma.followUp.findMany;
  const originalCallLogFindMany = prisma.callLog.findMany;
  let followUpPageCount = 0;
  prisma.followUp.findMany = async ({ skip }) => {
    followUpPageCount += 1;
    return skip === 0 ? [
      {
        id: 'contacted-follow-up',
        customerId: 'customer-a',
        vehicleId: 'vehicle-a',
        source: 'WARRANTY',
        followUpAt: new Date('2026-01-01'),
        vehicle: { saleDate: new Date('2023-01-10') },
        customer: { id: 'customer-a', fullName: 'Contacted Customer', mobileNumber: '9876543210' },
        cre: { id: 'cre-a', name: 'CRE A' },
      },
      {
        id: 'late-follow-up',
        customerId: 'customer-b',
        vehicleId: 'vehicle-b',
        source: 'WARRANTY',
        followUpAt: new Date('2026-01-02'),
        vehicle: { saleDate: new Date('2023-01-10') },
        customer: { id: 'customer-b', fullName: 'Late Customer', mobileNumber: '9876543211' },
        cre: { id: 'cre-a', name: 'CRE A' },
      },
    ] : [];
  };
  prisma.callLog.findMany = async () => [{
    vehicleId: 'vehicle-a',
    outcome: 'CONTACTED',
    callSource: 'WARRANTY',
    createdAt: new Date('2026-01-10T12:00:00'),
  }];
  try {
    const res = mockRes();
    await listFollowUps({
      user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-a' },
      query: { source: 'WARRANTY', contactStatus: 'Not contacted', limit: '1', offset: '0' },
    }, res);

    assert.equal(res.body.total, 1);
    assert.equal(res.body.followUps[0].id, 'late-follow-up');
    assert.equal(res.body.followUps[0].contactStatus, 'Not contacted');
    assert.equal(followUpPageCount, 1);
  } finally {
    prisma.followUp.findMany = originalFollowUpFindMany;
    prisma.callLog.findMany = originalCallLogFindMany;
  }
});

test('Free-Service CRE cannot access normal customer-list service sources', () => {
  const user = { role: 'FREE_SERVICE_CRE', freeServiceEnabled: true, warrantyEnabled: true };
  assert.deepEqual(allowedServiceSources(user), []);
  assert.equal(canAccessServiceSource(user, 'SERVICE'), false);
  assert.equal(canAccessServiceSource(user, 'FREE_SERVICE'), false);
  assert.equal(canAccessServiceSource(user, 'WARRANTY'), false);
});

test('unknown roles cannot access service sources', () => {
  const user = { role: 'AUDITOR' };
  assert.deepEqual(allowedServiceSources(user), []);
  assert.equal(canAccessServiceSource(user, 'SERVICE'), false);
  assert.equal(canAccessServiceSource(user, 'FREE_SERVICE'), false);
});

test('Free-Service CRE is blocked from Master Call List, customer, allocation, and regular CRE performance APIs', async () => {
  const user = { role: 'FREE_SERVICE_CRE', id: 'free-cre-1', ccmId: 'ccm-1' };
  for (const handler of [getCallList, getCustomers, listAllocations, getCrePerformanceSummary]) {
    const res = mockRes();
    await handler({ user, query: {} }, res);
    assert.equal(res.statusCode, 403);
  }
});

test('GM Master Call List scope only includes teams assigned to that GM or unassigned teams', async () => {
  let teamWhere;
  const database = {
    user: {
      findMany: async ({ where }) => {
        teamWhere = where;
        return [{ ccmId: 'ccm-owned' }, { ccmId: 'ccm-unassigned' }];
      },
    },
  };
  const user = { id: 'gm-1', role: 'GM' };

  const allTeams = await resolveMasterCallListVisibility(user, '', database);
  assert.deepEqual(teamWhere, {
    role: 'CCM',
    status: 'active',
    OR: [{ gmId: 'gm-1' }, { gmId: null }],
  });
  assert.deepEqual(allTeams.where, { ccmId: { in: ['ccm-owned', 'ccm-unassigned'] } });

  const selectedTeam = await resolveMasterCallListVisibility(user, 'ccm-owned', database);
  assert.deepEqual(selectedTeam.where, { ccmId: 'ccm-owned' });

  const unauthorizedTeam = await resolveMasterCallListVisibility(user, 'ccm-other', database);
  assert.equal(unauthorizedTeam.error, 'You are not permitted to view this CCM team.');
});

test('Admin Master Call List scope remains unrestricted unless a team is selected', async () => {
  const database = { user: { findMany: async () => assert.fail('Admin scope should not query team membership.') } };
  assert.deepEqual(await resolveMasterCallListVisibility({ role: 'ADMIN' }, '', database), { where: {} });
  assert.deepEqual(await resolveMasterCallListVisibility({ role: 'ADMIN' }, 'ccm-1', database), {
    where: { ccmId: 'ccm-1' },
  });
});

test('regular CRE Master Call List visibility includes only records assigned to that CRE', () => {
  assert.deepEqual(getVisibilityWhere({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' }), {
    ccmId: 'ccm-1',
    ownerUserId: 'cre-1',
  });

  test('customer-specific call history retains authenticated CRE and CCM visibility scopes', () => {
    const creWhere = callLogVisibility({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' }, 'customer-1');
    assert.equal(creWhere.ccmId, 'ccm-1');
    assert.equal(creWhere.customerId, 'customer-1');
    assert.equal(creWhere.assignedToId, 'cre-1');
    assert.deepEqual(creWhere.customer.is, {
      vehicles: {
        some: {
          ccmId: 'ccm-1',
          OR: [
            { allocations: { some: { creId: 'cre-1', ccmId: 'ccm-1', status: 'assigned' } } },
            { masterCallListEntries: { some: { ownerUserId: 'cre-1', ccmId: 'ccm-1' } } },
          ],
        },
      },
    });

    const ccmWhere = callLogVisibility({ role: 'CCM', ccmId: 'ccm-1' }, 'customer-1');
    assert.equal(ccmWhere.ccmId, 'ccm-1');
    assert.equal(ccmWhere.customerId, 'customer-1');
    assert.deepEqual(ccmWhere.OR, [
      { vehicleId: null, customer: { is: { ccmId: 'ccm-1' } } },
      { vehicle: { is: { ccmId: 'ccm-1' } } },
    ]);
  });

  test('CCM and CRE visit filters fail closed and enforce team plus current CRE assignment', () => {
    assert.deepEqual(workshopVisitVisibilityWhere({ role: 'CCM' }), {
      physicalVehicle: { is: { vehicles: { some: { ccmId: 'no-access' } } } },
    });
    assert.deepEqual(workshopVisitVisibilityWhere({ role: 'UNKNOWN', ccmId: 'ccm-1' }), { id: 'no-access' });
    assert.deepEqual(workshopVisitVisibilityWhere({ role: 'ADMIN' }), {});

    const where = workshopVisitVisibilityWhere({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' });
    assert.deepEqual(where.physicalVehicle, {
      is: {
        vehicles: {
          some: {
            ccmId: 'ccm-1',
            OR: [
              { allocations: { some: { creId: 'cre-1', ccmId: 'ccm-1', status: 'assigned' } } },
              { masterCallListEntries: { some: { ownerUserId: 'cre-1', ccmId: 'ccm-1' } } },
            ],
          },
        },
      },
    });
  });

  test('only active allocations or current Master Call List ownership grant CRE vehicle access', () => {
    const user = { role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' };
    assert.equal(isVehicleAssignedToCre({
      allocations: [{ creId: 'cre-1', ccmId: 'ccm-1', status: 'assigned' }],
      masterCallListEntries: [],
    }, user), true);
    assert.equal(isVehicleAssignedToCre({
      allocations: [{ creId: 'cre-1', ccmId: 'ccm-1', status: 'completed' }],
      masterCallListEntries: [],
    }, user), false);
    assert.equal(isVehicleAssignedToCre({
      allocations: [{ creId: 'cre-1', ccmId: 'ccm-2', status: 'assigned' }],
      masterCallListEntries: [],
    }, user), false);
    assert.equal(isVehicleAssignedToCre({
      allocations: [],
      masterCallListEntries: [{ ownerUserId: 'cre-1', ccmId: 'ccm-1' }],
    }, user), true);
  });

  test('unknown roles cannot read call history', () => {
    assert.deepEqual(callLogVisibility({ role: 'AUDITOR', id: 'user-1', ccmId: 'ccm-1' }), { id: 'no-access' });
  });

  test('dashboard query scopes preserve admin and GM cross-CCM access and isolate CCM/CRE metrics', () => {
    for (const role of ['ADMIN', 'GM']) {
      const scope = operationalReadScope({ role });
      assert.deepEqual(scope.customer, {});
      assert.deepEqual(scope.vehicle, {});
      assert.deepEqual(scope.call, {});
      assert.deepEqual(scope.followUp, {});
    }

    const ccmScope = operationalReadScope({ role: 'CCM', ccmId: 'ccm-1' });
    assert.deepEqual(ccmScope.customer, {
      OR: [
        { ccmId: 'ccm-1' },
        { vehicles: { some: { ccmId: 'ccm-1' } } },
      ],
    });
    assert.deepEqual(ccmScope.vehicle, { ccmId: 'ccm-1' });
    assert.deepEqual(ccmScope.call.OR, [
      { vehicleId: null, customer: { is: { ccmId: 'ccm-1' } } },
      { vehicle: { is: { ccmId: 'ccm-1' } } },
    ]);
    assert.deepEqual(operationalReadScope({ role: 'CCM' }).customer, {
      OR: [
        { ccmId: 'no-access' },
        { vehicles: { some: { ccmId: 'no-access' } } },
      ],
    });

    const creScope = operationalReadScope({
      role: 'CRE',
      id: 'cre-1',
      ccmId: 'ccm-1',
      freeServiceEnabled: false,
      warrantyEnabled: false,
    });
    assert.equal(creScope.vehicle.ccmId, 'ccm-1');
    assert.equal(creScope.call.createdById, 'cre-1');
    assert.deepEqual(creScope.call.callSource, { in: ['SERVICE'] });
    assert.deepEqual(creScope.followUp.source, { in: ['SERVICE'] });
    assert.equal(creScope.allocation.ccmId, 'ccm-1');
  });

  test('CCM Master Call List filters combine CRE, due category, repair type, and partial search', () => {
    const records = [
      {
        assigneeId: 'cre-1',
        customerName: 'Alex Hyundai',
        mobile: '9876543210',
        vin: 'VIN123',
        registrationNumber: 'KA01AA1234',
        dueCategory: '1y',
        type: 'Paid',
        workshopVisits: [{ repairOrderNo: 'RO-1001' }],
      },
      {
        assigneeId: null,
        customerName: 'Alex Service',
        dueCategory: '1y',
        type: 'Paid',
        workshopVisits: [],
      },
      {
        assigneeId: 'cre-1',
        customerName: 'Alex Service',
        dueCategory: '6m',
        type: 'Free',
        workshopVisits: [],
      },
    ];
    const { filters } = validateMasterCallListFilters({
      creId: 'cre-1',
      dueCategory: '1y',
      repairType: 'Paid',
      search: '  ro-10 ',
    });

    assert.deepEqual(filterMasterCallListRecords(records, filters, 'CCM'), [records[0]]);
    assert.deepEqual(filterMasterCallListRecords(records, filters, 'CRE'), [records[0]]);

    const { filters: unassignedFilters } = validateMasterCallListFilters({ creId: 'unassigned' });
    assert.deepEqual(filterMasterCallListRecords(records, unassignedFilters, 'CCM'), [records[1]]);
    const { filters: allDueFilters } = validateMasterCallListFilters({ dueCategory: 'allDue' });
    assert.deepEqual(filterMasterCallListRecords(records, allDueFilters, 'CCM'), records);
    const { filters: sixMonthFilters } = validateMasterCallListFilters({ dueCategory: '6m' });
    assert.deepEqual(filterMasterCallListRecords(records, sixMonthFilters, 'CCM'), [records[2]]);
    const today = new Date();
    const pastDueRecords = [
      { dueDate: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1), customerName: 'Past' },
      { dueDate: new Date(today.getFullYear(), today.getMonth(), today.getDate()), customerName: 'Today' },
    ];
    const { filters: pastDueFilters } = validateMasterCallListFilters({ dueCategory: 'pastDue' });
    assert.deepEqual(filterMasterCallListRecords(pastDueRecords, pastDueFilters, 'CCM'), [pastDueRecords[0]]);

    for (const search of ['alex hyu', '987654', 'vin123', 'ka01aa', 'ro-100']) {
      const { filters: searchFilters } = validateMasterCallListFilters({ search: ` ${search} ` });
      assert.deepEqual(filterMasterCallListRecords(records, searchFilters, 'CCM'), [records[0]]);
    }
  });

  test('CRE list filters cannot broaden the authenticated CRE data scope', () => {
    const assignedRecords = [
      { assigneeId: 'cre-1', customerName: 'Assigned Customer', dueCategory: '6m', type: 'Free', workshopVisits: [] },
    ];
    const { filters } = validateMasterCallListFilters({
      creId: 'cre-2',
      dueCategory: 'allDue',
      repairType: 'Free',
      search: 'assigned',
    });

    assert.deepEqual(filterMasterCallListRecords(assignedRecords, filters, 'CRE'), assignedRecords);
    assert.deepEqual(getVisibilityWhere({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' }), {
      ccmId: 'ccm-1',
      ownerUserId: 'cre-1',
    });
  });

  test('Master Call List filter validation rejects unsupported values and oversized searches', () => {
    assert.equal(validateMasterCallListFilters({ dueCategory: 'recent' }).error, 'dueCategory must be 6m, 1y, allDue, or pastDue.');
    assert.equal(validateMasterCallListFilters({ repairType: 'Unknown' }).error, 'repairType is not supported.');
    assert.equal(validateMasterCallListFilters({ search: 'x'.repeat(201) }).error, 'search must be 200 characters or fewer.');
  });
  assert.deepEqual(getVisibilityWhere({ role: 'CRE', id: 'cre-1' }), {
    ccmId: 'no-access',
    ownerUserId: 'cre-1',
  });
});

test('editing a CRE preserves saved switches when fields are omitted', () => {
  assert.deepEqual(resolveCreServicePermissions({
    existingRole: 'CRE',
    nextRole: 'CRE',
    existingFreeServiceEnabled: true,
    existingWarrantyEnabled: false,
  }), { freeServiceEnabled: true, warrantyEnabled: false });
});

test('editing a CRE persists explicit on and off switch values independently', () => {
  assert.deepEqual(resolveCreServicePermissions({
    existingRole: 'CRE',
    nextRole: 'CRE',
    existingFreeServiceEnabled: true,
    existingWarrantyEnabled: true,
    freeServiceEnabled: false,
    warrantyEnabled: true,
  }), { freeServiceEnabled: false, warrantyEnabled: true });
  assert.deepEqual(resolveCreServicePermissions({
    existingRole: 'CRE',
    nextRole: 'CRE',
    existingFreeServiceEnabled: false,
    existingWarrantyEnabled: false,
    freeServiceEnabled: true,
    warrantyEnabled: false,
  }), { freeServiceEnabled: true, warrantyEnabled: false });
});

test('unauthorized CREs cannot directly request the Free Service or Warranty lists', async () => {
  for (const [handler, category] of [[getFreeServiceList, 'Free Service'], [getWarrantyList, 'Warranty']]) {
    const res = mockRes();
    await handler({ user: { role: 'CRE', id: 'cre-1' } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.message, new RegExp(category, 'i'));
  }
});

test('unauthorized CREs cannot list, create follow-ups, or log calls for restricted sources', async () => {
  const cases = [
    [listFollowUps, { query: { source: 'FREE_SERVICE' } }],
    [listFollowUps, { query: { source: 'WARRANTY' } }],
    [createFollowUp, { body: { customerId: 'customer-1', category: 'callback', source: 'FREE_SERVICE', followUpAt: '2026-11-01T10:00:00Z' } }],
    [createFollowUp, { body: { customerId: 'customer-1', category: 'callback', source: 'WARRANTY', followUpAt: '2026-11-01T10:00:00Z' } }],
    [createCallLog, { body: { customerId: 'customer-1', vehicleId: 'vehicle-1', milestoneId: 'milestone-1', outcome: 'CONTACTED', callSource: 'FREE_SERVICE' } }],
    [createCallLog, { body: { customerId: 'customer-1', vehicleId: 'vehicle-1', outcome: 'CONTACTED', callSource: 'WARRANTY' } }],
  ];

  for (const [handler, input] of cases) {
    const res = mockRes();
    await handler({ user: { role: 'CRE', id: 'cre-1' }, ...input }, res);
    assert.equal(res.statusCode, 403);
  }
});
