import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { getWarrantyList } from '../src/controllers/serviceListsController.js';
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
    return rows;
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
