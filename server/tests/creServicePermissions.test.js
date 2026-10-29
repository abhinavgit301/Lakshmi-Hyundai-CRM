import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedServiceSources,
  canAccessServiceSource,
  resolveCreServicePermissions,
} from '../src/utils/creServicePermissions.js';
import { createCallLog, createFollowUp, getCrePerformanceSummary, listFollowUps } from '../src/controllers/callWorkflowController.js';
import { getFreeServiceList, getWarrantyList } from '../src/controllers/serviceListsController.js';
import { getCallList, getCustomers, getVisibilityWhere } from '../src/controllers/recordsController.js';
import { listAllocations } from '../src/controllers/allocationController.js';

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
