import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomer } from '../src/controllers/customerController.js';
import { prisma } from '../src/config/prisma.js';

function response() {
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

async function withPrismaMocks(overrides, run) {
  const getMockTarget = (path) => path === '$transaction'
    ? { target: prisma, method: '$transaction' }
    : (() => {
    const [model, method] = path.split('.');
      return { target: prisma[model], method };
    })();
  const originals = Object.fromEntries(Object.keys(overrides).map((path) => {
    const { target, method } = getMockTarget(path);
    return [path, target[method]];
  }));
  for (const [path, implementation] of Object.entries(overrides)) {
    const { target, method } = getMockTarget(path);
    target[method] = implementation;
  }
  try {
    await run();
  } finally {
    for (const [path, implementation] of Object.entries(originals)) {
      const { target, method } = getMockTarget(path);
      target[method] = implementation;
    }
  }
}

test('Admin can create one customer with vehicles owned by different CCMs', async () => {
  const vehicleCreates = [];
  const physicalVehicles = new Map();
  await withPrismaMocks({
    'user.findMany': async () => [{ ccmId: 'ccm-a' }, { ccmId: 'ccm-b' }],
    '$transaction': async (callback) => callback({
      $queryRaw: async () => [],
      physicalVehicle: {
        findUnique: async ({ where }) => physicalVehicles.get(where.vin) || null,
        create: async ({ data }) => {
          const record = { id: `physical-${data.vin}`, ...data };
          physicalVehicles.set(data.vin, record);
          return record;
        },
      },
      customer: {
        create: async ({ data }) => ({ id: 'customer-1', ...data }),
        findUniqueOrThrow: async ({ include }) => ({
          id: 'customer-1',
          vehicles: include.vehicles ? vehicleCreates.map(({ data }) => ({ id: 'vehicle', ...data })) : [],
        }),
      },
      vehicle: {
        create: async (args) => {
          vehicleCreates.push(args);
          return { id: `vehicle-${vehicleCreates.length}`, ...args.data };
        },
      },
    }),
  }, async () => {
    const res = response();
    await createCustomer({
      user: { id: 'admin-1', role: 'ADMIN' },
      body: {
        fullName: 'Customer',
        ccmId: 'ccm-a',
        vehicles: [
          { vin: '1HGBH41JXZ', ccmId: 'ccm-a' },
          { vin: '2HGBH41JXZ', ccmId: 'ccm-b' },
        ],
      },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(vehicleCreates.map(({ data }) => data.ccmId), ['ccm-a', 'ccm-b']);
    assert.equal(vehicleCreates[0].data.customerId, 'customer-1');
    assert.equal(vehicleCreates[1].data.customerId, 'customer-1');
    assert.notEqual(vehicleCreates[0].data.physicalVehicleId, vehicleCreates[1].data.physicalVehicleId);
  });
});

test('CCM cannot create a vehicle under a different CCM than its authenticated team', async () => {
  let writeCount = 0;
  await withPrismaMocks({
    'user.findMany': async () => [{ ccmId: 'ccm-a' }],
    'customer.create': async () => { writeCount += 1; },
  }, async () => {
    const res = response();
    await createCustomer({
      user: { id: 'ccm-user-a', role: 'CCM', ccmId: 'ccm-a' },
      body: {
        fullName: 'Customer',
        ccmId: 'ccm-a',
        vehicles: [{ vin: '1HGBH41JXZ', ccmId: 'ccm-b' }],
      },
    }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(writeCount, 0);
  });
});
