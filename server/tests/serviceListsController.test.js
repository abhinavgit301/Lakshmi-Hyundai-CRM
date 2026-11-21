import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { getFreeServiceList, getWarrantyList } from '../src/controllers/serviceListsController.js';
import { workshopToday } from '../src/utils/workshopTime.js';

function mockResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function masterRow(id, saleDate) {
  return {
    id: `record-${id}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ccmId: 'ccm-test',
    ownerUserId: null,
    customerName: `Customer ${id}`,
    mobileNumber: '1234567890',
    vin: `VIN-${id}`,
    status: 'pending',
    registrationNumber: null,
    vehicle: {
      id: `vehicle-${id}`,
      customerId: `customer-${id}`,
      model: 'Model',
      saleDate,
      registrationNumber: null,
      physicalVehicleId: `physical-${id}`,
      physicalVehicle: { workshopVisits: [] },
      allocations: [],
      monthlyDataEntries: [],
      appointments: [],
      customer: { appointments: [] },
    },
  };
}

function installPrismaMocks(t, rows) {
  const calls = { master: [], callLog: [], followUp: [] };
  const originals = [
    ['masterCallList', 'findMany'],
    ['user', 'findMany'],
    ['callLog', 'findMany'],
    ['followUp', 'findMany'],
  ].map(([delegate, method]) => ({ target: prisma[delegate], method, original: prisma[delegate][method] }));
  prisma.masterCallList.findMany = async (args) => {
    calls.master.push(args);
    return [...rows];
  };
  prisma.user.findMany = async () => [];
  prisma.callLog.findMany = async (args) => {
    calls.callLog.push(args);
    return [];
  };
  prisma.followUp.findMany = async (args) => {
    calls.followUp.push(args);
    return [];
  };
  t.after(() => {
    for (const { target, method, original } of originals) target[method] = original;
  });
  return calls;
}

function callableRows() {
  const today = workshopToday(new Date());
  const saleDate = new Date(today.getFullYear(), today.getMonth() - 35, 1);
  return [masterRow('1', saleDate), masterRow('2', saleDate), masterRow('3', saleDate)];
}

test('Warranty loads contact and follow-up details only for the requested page by default', async (t) => {
  const calls = installPrismaMocks(t, callableRows());
  const response = mockResponse();
  await getWarrantyList({
    user: { id: 'warranty-page-test', role: 'CCM', ccmId: 'ccm-test' },
    query: { limit: '1', offset: '0' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.records.length, 1);
  assert.deepEqual(calls.callLog[0].where.vehicleId.in, [response.body.records[0].vehicleId]);
  assert.deepEqual(calls.followUp[0].where.vehicleId.in, [response.body.records[0].vehicleId]);
});

test('Warranty contact-status filtering reads call history across the candidate set', async (t) => {
  const calls = installPrismaMocks(t, callableRows());
  const response = mockResponse();
  await getWarrantyList({
    user: { id: 'warranty-status-test', role: 'CCM', ccmId: 'ccm-test' },
    query: { limit: '1', offset: '0', contactStatus: 'Not contacted' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.callLog[0].where.vehicleId.in, ['vehicle-1', 'vehicle-2', 'vehicle-3']);
  assert.deepEqual(calls.followUp[0].where.vehicleId.in, [response.body.records[0].vehicleId]);
});

test('Warranty status lookup batches large candidate sets and retains the team scope', async (t) => {
  const rows = callableRows();
  const base = rows[0].vehicle.saleDate;
  const many = Array.from({ length: 1001 }, (_, index) => masterRow(String(index), base));
  const calls = installPrismaMocks(t, many);
  prisma.masterCallList.findMany = async (args) => {
    calls.master.push(args);
    if (args.cursor) return [];
    return [...many];
  };
  const response = mockResponse();
  await getWarrantyList({
    user: { id: 'warranty-batching-test', role: 'CCM', ccmId: 'ccm-test' },
    query: { limit: '1', contactStatus: 'Not contacted', followUpStatus: 'notScheduled' },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.total, 1001);
  assert.deepEqual(calls.callLog.map(({ where }) => where.vehicleId.in.length), [500, 500, 1]);
  assert.deepEqual(calls.followUp.map(({ where }) => where.vehicleId.in.length), [500, 500, 1]);
  assert.ok(calls.callLog.every(({ where }) => where.ccmId === 'ccm-test' && where.callSource === 'WARRANTY'));
  assert.ok(calls.followUp.every(({ where }) => where.ccmId === 'ccm-test' && where.source === 'WARRANTY'));
});

test('Free Service status filtering scopes candidate reads and preserves the legacy empty-candidate fallback', async (t) => {
  const today = workshopToday(new Date());
  const saleDate = new Date(today.getFullYear(), today.getMonth() - 2, today.getDate());
  const row = masterRow('free', saleDate);
  const calls = installPrismaMocks(t, [row]);
  const originals = {
    transaction: prisma.$transaction,
    milestones: prisma.freeServiceMilestone.findMany,
    followUps: prisma.followUp.findMany,
    followUpFirst: prisma.followUp.findFirst,
  };
  t.after(() => {
    prisma.$transaction = originals.transaction;
    prisma.freeServiceMilestone.findMany = originals.milestones;
    prisma.followUp.findMany = originals.followUps;
    prisma.followUp.findFirst = originals.followUpFirst;
  });
  prisma.$transaction = async () => ({ changed: false });
  prisma.freeServiceMilestone.findMany = async () => [{
    id: 'milestone-free', vehicleId: row.vehicle.id, milestone: 1, dueDate: today, status: 'pending',
  }];
  const otherSourceFollowUp = { id: 'other-source', milestoneId: 'milestone-free', followUpAt: today };
  prisma.followUp.findMany = async (args) => {
    calls.followUp.push(args);
    return args.where.source === 'FREE_SERVICE' ? [] : [otherSourceFollowUp];
  };
  let hasUnrelated = true;
  prisma.followUp.findFirst = async (args) => {
    assert.equal(args.where.ccmId, 'ccm-test');
    assert.equal(args.where.source, 'FREE_SERVICE');
    return hasUnrelated ? { id: 'unrelated-free' } : null;
  };
  const request = async (id) => {
    const response = mockResponse();
    await getFreeServiceList({
      user: { id, role: 'CCM', ccmId: 'ccm-test' },
      query: { limit: '1', followUpStatus: 'notScheduled' },
    }, response);
    return response;
  };
  const unrelated = await request('free-unrelated-test');
  assert.equal(unrelated.body.records.length, 1);
  assert.equal(unrelated.body.records[0].followUp, null);
  assert.deepEqual(calls.followUp[0].where.milestoneId.in, ['milestone-free']);
  assert.equal(calls.followUp.length, 1);

  hasUnrelated = false;
  calls.followUp.length = 0;
  const noFreeFollowUps = await request('free-empty-test');
  assert.equal(noFreeFollowUps.body.records.length, 1);
  assert.deepEqual(noFreeFollowUps.body.records[0].followUp, { id: otherSourceFollowUp.id, followUpAt: today });
  assert.equal(calls.followUp.length, 2);
});
