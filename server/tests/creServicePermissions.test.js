import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedServiceSources,
  canAccessServiceSource,
  resolveCreServicePermissions,
} from '../src/utils/creServicePermissions.js';
import { callLogVisibility, createCallLog, createFollowUp, getCrePerformanceSummary, listFollowUps } from '../src/controllers/callWorkflowController.js';
import { getFreeServiceList, getWarrantyList } from '../src/controllers/serviceListsController.js';
import { getCallList, getCustomers, getVisibilityWhere } from '../src/controllers/recordsController.js';
import { listAllocations } from '../src/controllers/allocationController.js';
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

test('Free-Service CRE cannot access normal customer-list service sources', () => {
  const user = { role: 'FREE_SERVICE_CRE', freeServiceEnabled: true, warrantyEnabled: true };
  assert.deepEqual(allowedServiceSources(user), []);
  assert.equal(canAccessServiceSource(user, 'SERVICE'), false);
  assert.equal(canAccessServiceSource(user, 'FREE_SERVICE'), false);
  assert.equal(canAccessServiceSource(user, 'WARRANTY'), false);
});

test('Free-Service CRE is blocked from Master Call List, customer, allocation, and regular CRE performance APIs', async () => {
  const user = { role: 'FREE_SERVICE_CRE', id: 'free-cre-1', ccmId: 'ccm-1' };
  for (const handler of [getCallList, getCustomers, listAllocations, getCrePerformanceSummary]) {
    const res = mockRes();
    await handler({ user, query: {} }, res);
    assert.equal(res.statusCode, 403);
  }
});

test('regular CRE Master Call List visibility includes only records assigned to that CRE', () => {
  assert.deepEqual(getVisibilityWhere({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' }), {
    ccmId: 'ccm-1',
    ownerUserId: 'cre-1',
  });

  test('customer-specific call history retains authenticated CRE and CCM visibility scopes', () => {
    const creWhere = callLogVisibility({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-1' }, 'customer-1');
    assert.equal(creWhere.customerId, 'customer-1');
    assert.equal(creWhere.assignedToId, 'cre-1');
    assert.deepEqual(creWhere.customer.is, {
      ccmId: 'ccm-1',
      vehicles: {
        some: {
          OR: [
            { allocations: { some: { creId: 'cre-1' } } },
            { masterCallListEntries: { some: { ownerUserId: 'cre-1', ccmId: 'ccm-1' } } },
          ],
        },
      },
    });

    const ccmWhere = callLogVisibility({ role: 'CCM', ccmId: 'ccm-1' }, 'customer-1');
    assert.equal(ccmWhere.customerId, 'customer-1');
    assert.deepEqual(ccmWhere.customer.is, { OR: [{ ccmId: 'ccm-1' }, { ccmId: null }] });
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
    assert.equal(validateMasterCallListFilters({ dueCategory: 'recent' }).error, 'dueCategory must be 6m, 1y, or allDue.');
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
