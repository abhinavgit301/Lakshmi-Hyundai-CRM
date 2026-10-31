import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { updateCallListAssignee } from '../src/controllers/recordsController.js';

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

test('CCM can assign a deactivation review-queue entry and preserve the assignment event', async (t) => {
  const entry = {
    id: 'call-list-1',
    ccmId: 'ccm-1',
    ownerUserId: null,
    vin: 'VIN-1',
    vehicle: { id: 'vehicle-1', ccmId: 'ccm-1' },
  };
  const assignmentEvents = [];
  let updatedEntry;
  replaceMethod(t, prisma.masterCallList, 'findFirst', async () => entry);
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    $queryRaw: async () => [],
    masterCallList: {
      findFirst: async () => entry,
      update: async ({ data }) => {
        updatedEntry = { ...entry, ...data };
        return updatedEntry;
      },
    },
    user: {
      findFirst: async () => ({ id: 'cre-new', name: 'New CRE' }),
    },
    allocation: {
      findMany: async () => [],
    },
    creAssignmentHistory: {
      create: async ({ data }) => {
        assignmentEvents.push(data);
        return data;
      },
    },
    auditLog: { create: async () => ({}) },
  }));
  const response = responseRecorder();

  await updateCallListAssignee({
    params: { id: entry.id },
    body: { assigneeId: 'cre-new', reason: 'Reviewed by CCM' },
    user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-1' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(updatedEntry.ownerUserId, 'cre-new');
  assert.equal(updatedEntry.assignmentNeedsReview, false);
  assert.deepEqual(assignmentEvents, [{
    vehicleId: 'vehicle-1',
    allocationId: null,
    masterCallListId: 'call-list-1',
    ccmId: 'ccm-1',
    previousCreId: null,
    newCreId: 'cre-new',
    actorUserId: 'ccm-user',
    reason: 'Reviewed by CCM',
    eventType: 'ASSIGNED',
  }]);
});

test('CCM assignment of an existing MCL queue row also reassigns its unassigned allocation with history', async (t) => {
  const entry = {
    id: 'call-list-queue',
    ccmId: 'ccm-1',
    ownerUserId: null,
    vin: 'VIN-QUEUE',
    vehicle: { id: 'vehicle-queue', ccmId: 'ccm-1' },
  };
  const allocations = [{
    id: 'allocation-queue',
    vehicleId: 'vehicle-queue',
    creId: null,
  }];
  const assignmentEvents = [];
  replaceMethod(t, prisma.masterCallList, 'findFirst', async () => entry);
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    $queryRaw: async () => [],
    masterCallList: {
      findFirst: async () => ({ ...entry, vehicle: { ...entry.vehicle } }),
      update: async ({ data }) => ({ ...entry, ...data }),
    },
    user: {
      findFirst: async () => ({ id: 'cre-new', name: 'New CRE' }),
    },
    allocation: {
      findMany: async () => allocations,
      update: async ({ where, data }) => {
        const allocation = allocations.find((item) => item.id === where.id);
        Object.assign(allocation, data);
        return allocation;
      },
    },
    creAssignmentHistory: {
      create: async ({ data }) => {
        assignmentEvents.push(data);
        return data;
      },
    },
    auditLog: { create: async () => ({}) },
  }));
  const response = responseRecorder();

  await updateCallListAssignee({
    params: { id: entry.id },
    body: { assigneeId: 'cre-new' },
    user: { id: 'ccm-user', role: 'CCM', ccmId: 'ccm-1' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(allocations[0].creId, 'cre-new');
  assert.deepEqual(assignmentEvents.map(({ allocationId, masterCallListId, previousCreId, newCreId }) => ({
    allocationId,
    masterCallListId,
    previousCreId,
    newCreId,
  })), [
    { allocationId: null, masterCallListId: 'call-list-queue', previousCreId: null, newCreId: 'cre-new' },
    { allocationId: 'allocation-queue', masterCallListId: null, previousCreId: null, newCreId: 'cre-new' },
  ]);
});
