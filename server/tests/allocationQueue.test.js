import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { updateAllocation } from '../src/controllers/allocationController.js';
import { buildAllocationQueueRecords } from '../src/utils/masterCallList.js';

after(async () => {
  await prisma.$disconnect();
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
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

function replaceMethod(t, target, methodName, implementation) {
  const original = target[methodName];
  target[methodName] = implementation;
  t.after(() => {
    target[methodName] = original;
  });
}

function setupAllocationReassignment(t, { mclEntries = [], extraAllocations = [] } = {}) {
  const allocations = [{
    id: 'allocation-1',
    vehicleId: 'vehicle-1',
    ccmId: 'ccm-1',
    creId: null,
    status: 'assigned',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    vehicle: {
      id: 'vehicle-1',
      vin: 'VIN-1',
      registrationNumber: 'REG-1',
      ccmId: 'ccm-1',
      customer: { id: 'customer-1', ccmId: 'customer-legacy', fullName: 'Customer', mobileNumber: null },
    },
  }, ...extraAllocations];
  const assignmentHistory = [];
  const calls = [];
  const mcl = mclEntries.map((entry) => ({ ...entry }));
  const current = () => allocations.find((allocation) => allocation.id === 'allocation-1');

  replaceMethod(t, prisma.allocation, 'findFirst', async () => current());
  replaceMethod(t, prisma.user, 'findFirst', async () => ({ id: 'cre-active' }));
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    $queryRaw: async () => [],
    user: {
      findFirst: async () => ({ id: 'cre-active', name: 'Active CRE' }),
    },
    allocation: {
      findFirst: async () => ({
        ...current(),
        vehicle: { ...current().vehicle },
        cre: { id: 'cre-active', name: 'Active CRE' },
      }),
      findMany: async () => { calls.push('allocation.findMany'); return allocations; },
      update: async ({ where, data }) => {
        const allocation = allocations.find((item) => item.id === where.id);
        Object.assign(allocation, data);
        return allocation;
      },
    },
    masterCallList: {
      findMany: async ({ where }) => mcl.filter((entry) => entry.vin === where.vin && entry.ccmId === where.ccmId),
      update: async ({ where, data }) => {
        const entry = mcl.find((item) => item.id === where.id);
        Object.assign(entry, data);
        return entry;
      },
      create: async () => {
        throw new Error('The reassignment must not fabricate a Master Call List row.');
      },
    },
    creAssignmentHistory: {
      create: async ({ data }) => {
        calls.push('assignmentHistory.create');
        assignmentHistory.push(data);
        return data;
      },
    },
    auditLog: { create: async () => ({}) },
  }));
  return { allocations, assignmentHistory, mcl, calls };
}

test('CCM can reassign an allocation-only vehicle without a mobile number or fabricated MCL row', async (t) => {
  const state = setupAllocationReassignment(t, {
    extraAllocations: [{
      id: 'allocation-2',
      vehicleId: 'vehicle-1',
      ccmId: 'ccm-1',
      creId: null,
      status: 'assigned',
      vehicle: { id: 'vehicle-1', vin: 'VIN-1', ccmId: 'ccm-1', customer: { mobileNumber: null } },
    }],
  });
  const response = responseRecorder();

  await updateAllocation({
    params: { id: 'allocation-1' },
    body: { creId: 'cre-active' },
    user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-1' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.ok(response.body?.allocation);
  assert.equal(state.allocations[0].creId, 'cre-active');
  assert.equal(state.allocations[1].creId, 'cre-active');
  assert.equal(state.mcl.length, 0);
  assert.deepEqual(state.assignmentHistory.map(({ allocationId, previousCreId, newCreId }) => ({
    allocationId,
    previousCreId,
    newCreId,
  })), [{
    allocationId: 'allocation-1',
    previousCreId: null,
    newCreId: 'cre-active',
  }, {
    allocationId: 'allocation-2',
    previousCreId: null,
    newCreId: 'cre-active',
  }]);
});

test('CCM reassignment preserves existing MCL data and records allocation and MCL history', async (t) => {
  const state = setupAllocationReassignment(t, {
    extraAllocations: [{
      id: 'allocation-2',
      vehicleId: 'vehicle-1',
      ccmId: 'ccm-1',
      creId: null,
      status: 'assigned',
      vehicle: { id: 'vehicle-1', vin: 'VIN-1', ccmId: 'ccm-1', customer: { mobileNumber: null } },
    }],
    mclEntries: [{
      id: 'mcl-1',
      vin: 'VIN-1',
      ccmId: 'ccm-1',
      ownerUserId: null,
      customerName: 'Existing name',
      mobileNumber: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }],
  });
  const response = responseRecorder();

  await updateAllocation({
    params: { id: 'allocation-1' },
    body: { creId: 'cre-active' },
    user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-1' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(state.mcl[0].customerName, 'Existing name');
  assert.equal(state.mcl[0].mobileNumber, null);
  assert.equal(state.mcl[0].ownerUserId, 'cre-active');
  assert.deepEqual(state.assignmentHistory.map(({ allocationId, masterCallListId }) => ({
    allocationId,
    masterCallListId,
  })), [
    { allocationId: 'allocation-1', masterCallListId: null },
    { allocationId: 'allocation-2', masterCallListId: null },
    { allocationId: null, masterCallListId: 'mcl-1' },
  ]);
});

test('CCM cannot see or reassign an allocation owned by another CCM', async (t) => {
  let queriedWhere;
  replaceMethod(t, prisma.allocation, 'findFirst', async ({ where }) => {
    queriedWhere = where;
    return null;
  });
  const response = responseRecorder();

  await updateAllocation({
    params: { id: 'allocation-other-team' },
    body: { creId: 'cre-active' },
    user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-1' },
  }, response);

  assert.equal(response.statusCode, 404);
  assert.equal(queriedWhere.ccmId, 'ccm-1');
});

test('MCL-backed and allocation-only work has one CCM queue representation per VIN', () => {
  const allocation = (id, vin) => ({
    id,
    ccmId: 'ccm-1',
    serviceType: 'Service',
    vehicle: { id: `vehicle-${vin}`, vin, customer: null },
  });
  const masterRecords = [
    { id: 'mcl-1', vin: 'VIN-1', ccmId: 'ccm-1', assigneeId: null },
    { id: 'mcl-duplicate', vin: 'VIN-1', ccmId: 'ccm-1', assigneeId: null },
  ];

  const queue = buildAllocationQueueRecords(
    masterRecords.slice(0, 1),
    [allocation('allocation-mcl', 'VIN-1'), allocation('allocation-only-a', 'VIN-2'), allocation('allocation-only-b', 'VIN-2')],
  );

  assert.equal(queue.length, 1);
  assert.equal(queue[0].vin, 'VIN-2');
});
