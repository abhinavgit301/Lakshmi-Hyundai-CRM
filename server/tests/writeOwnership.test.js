import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallLog, createFollowUp } from '../src/controllers/callWorkflowController.js';
import { createManualCallListEntry } from '../src/controllers/recordsController.js';
import { prisma } from '../src/config/prisma.js';
import { isVehicleAssignedToCre } from '../src/utils/creAccess.js';

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

function makeVehicle(id, ccmId, allocations = [], masterCallListEntries = []) {
  return { id, ccmId, allocations, masterCallListEntries };
}

function makeCustomer(id, ccmId, vehicles) {
  return { id, ccmId, vehicles };
}

async function withPrismaMocks(overrides, run) {
  const originals = Object.fromEntries(Object.entries(overrides).map(([path]) => {
    const [model, method] = path.split('.');
    return [path, model === '$transaction' ? prisma.$transaction : prisma[model][method]];
  }));
  for (const [path, implementation] of Object.entries(overrides)) {
    const [model, method] = path.split('.');
    if (model === '$transaction') prisma.$transaction = implementation;
    else prisma[model][method] = implementation;
  }
  try {
    await run();
  } finally {
    for (const [path, implementation] of Object.entries(originals)) {
      const [model, method] = path.split('.');
      if (model === '$transaction') prisma.$transaction = implementation;
      else prisma[model][method] = implementation;
    }
  }
}

test('manual repair-order entry normalizes the RO and checks duplicates within the selected CCM', async () => {
  let duplicateLookup;
  await withPrismaMocks({
    'user.findFirst': async () => ({ ccmId: 'ccm-a' }),
    'vehicle.findUnique': async () => ({ ccmId: 'ccm-a', registrationNumber: null }),
    'workshopVisit.findMany': async ({ where }) => {
      duplicateLookup = where;
      return [{
        ccmId: 'ccm-a',
        repairOrderNo: 'RO 100',
        normalizedRepairOrderNo: 'RO 100',
        vehicle: { vin: '1HGBH41JXZ' },
      }];
    },
  }, async () => {
    const res = mockRes();
    await createManualCallListEntry({
      user: { id: 'ccm-user-a', role: 'CCM', ccmId: 'ccm-a' },
      body: {
        roNumber: ' ro \t 100 ',
        vin: '1HGBH41JXZ',
        customerName: 'Customer',
        mobileNumber: '9000000000',
      },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(duplicateLookup, {
      ccmId: 'ccm-a',
      normalizedRepairOrderNo: 'RO 100',
    });
  });
});

test('CRE cannot log a call for another CCM customer', async () => {
  const customerB = makeCustomer('customer-b', 'ccm-b', [
    makeVehicle('vehicle-b', 'ccm-b', [{ creId: 'cre-b1', ccmId: 'ccm-b', status: 'assigned' }]),
  ]);
  let writeCount = 0;
  await withPrismaMocks({
    'customer.findUnique': async () => customerB,
    '$transaction': async () => { writeCount += 1; },
  }, async () => {
    const res = mockRes();
    await createCallLog({
      user: { id: 'cre-a1', role: 'CRE', ccmId: 'ccm-a' },
      body: { customerId: 'customer-b', vehicleId: 'vehicle-b', outcome: 'CONTACTED' },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(writeCount, 0);
  });
});

test('CRE assigned to one vehicle cannot call a sibling CRE vehicle', async () => {
  const customerA = makeCustomer('customer-a', 'ccm-a', [
    makeVehicle('vehicle-a1', 'ccm-a', [{ creId: 'cre-a1', ccmId: 'ccm-a', status: 'assigned' }]),
    makeVehicle('vehicle-a2', 'ccm-a', [{ creId: 'cre-a2', ccmId: 'ccm-a', status: 'assigned' }]),
  ]);
  let writeCount = 0;
  await withPrismaMocks({
    'customer.findUnique': async () => customerA,
    '$transaction': async () => { writeCount += 1; },
  }, async () => {
    const res = mockRes();
    await createCallLog({
      user: { id: 'cre-a1', role: 'CRE', ccmId: 'ccm-a' },
      body: { customerId: 'customer-a', vehicleId: 'vehicle-a2', outcome: 'CONTACTED' },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(writeCount, 0);
  });
});

test('inactive allocations do not grant CRE call access', async () => {
  const customerA = makeCustomer('customer-a', 'ccm-a', [
    makeVehicle('vehicle-a', 'ccm-a', [{ creId: 'cre-a1', ccmId: 'ccm-a', status: 'completed' }]),
  ]);
  let writeCount = 0;
  await withPrismaMocks({
    'customer.findUnique': async () => customerA,
    '$transaction': async () => { writeCount += 1; },
  }, async () => {
    const res = mockRes();
    await createCallLog({
      user: { id: 'cre-a1', role: 'CRE', ccmId: 'ccm-a' },
      body: { customerId: 'customer-a', vehicleId: 'vehicle-a', outcome: 'CONTACTED' },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(writeCount, 0);
  });
});

test('CCM vehicle call ownership comes from the vehicle, not customer attribution or the request body', async () => {
  const customerA = makeCustomer('customer-a', 'ccm-b', [makeVehicle('vehicle-a', 'ccm-a')]);
  let createArgs;
  const transaction = {
    callLog: { create: async (args) => { createArgs = args; return { id: 'call-1' }; } },
    followUp: { findMany: async () => [] },
  };
  await withPrismaMocks({
    'customer.findUnique': async () => customerA,
    '$transaction': async (callback) => callback(transaction),
  }, async () => {
    const res = mockRes();
    await createCallLog({
      user: { id: 'ccm-user-a', role: 'CCM', ccmId: 'ccm-a' },
      body: { customerId: 'customer-a', vehicleId: 'vehicle-a', ccmId: 'ccm-b', outcome: 'CONTACTED' },
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(createArgs.data.ccmId, 'ccm-a');
  });
});

test('CRE follow-up ownership comes from the assigned vehicle despite customer attribution', async () => {
  const customerA = makeCustomer('customer-a', 'ccm-b', [
    makeVehicle('vehicle-a', 'ccm-a', [], [{ ownerUserId: 'cre-a1', ccmId: 'ccm-a' }]),
  ]);
  let createArgs;
  await withPrismaMocks({
    'customer.findUnique': async () => customerA,
    'followUp.create': async (args) => { createArgs = args; return { id: 'follow-up-1' }; },
  }, async () => {
    const res = mockRes();
    await createFollowUp({
      user: { id: 'cre-a1', role: 'CRE', ccmId: 'ccm-a' },
      body: {
        customerId: 'customer-a',
        vehicleId: 'vehicle-a',
        category: 'callback',
        followUpAt: '2026-11-01T10:00:00Z',
        ccmId: 'ccm-b',
      },
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(createArgs.data.ccmId, 'ccm-a');
    assert.equal(createArgs.data.creId, 'cre-a1');
  });
});

test('follow-up creation validates the specific CRE vehicle and milestone relationship', async () => {
  const customerA = makeCustomer('customer-a', 'ccm-a', [
    makeVehicle('vehicle-a', 'ccm-a', [], [{ ownerUserId: 'cre-a1', ccmId: 'ccm-a' }]),
  ]);
  let createCount = 0;
  await withPrismaMocks({
    'customer.findUnique': async () => customerA,
    'freeServiceMilestone.findUnique': async () => ({ vehicleId: 'vehicle-other' }),
    'followUp.create': async () => { createCount += 1; },
  }, async () => {
    const res = mockRes();
    await createFollowUp({
      user: { id: 'cre-a1', role: 'CRE', ccmId: 'ccm-a', freeServiceEnabled: true },
      body: {
        customerId: 'customer-a',
        vehicleId: 'vehicle-a',
        milestoneId: 'milestone-other',
        source: 'FREE_SERVICE',
        category: 'callback',
        followUpAt: '2026-11-01T10:00:00Z',
        ccmId: 'ccm-b',
      },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(createCount, 0);
  });
});

test('Master Call List reassignment is an independent valid CRE access grant', () => {
  const vehicle = makeVehicle('vehicle-a', 'ccm-a', [], [{ ownerUserId: 'cre-a2', ccmId: 'ccm-a' }]);
  assert.equal(isVehicleAssignedToCre(vehicle, { id: 'cre-a2', ccmId: 'ccm-a' }), true);
  assert.equal(isVehicleAssignedToCre(vehicle, { id: 'cre-a1', ccmId: 'ccm-a' }), false);
  assert.equal(isVehicleAssignedToCre(vehicle, { id: 'cre-a2', ccmId: 'ccm-b' }), false);
});
