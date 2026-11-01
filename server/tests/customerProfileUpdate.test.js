import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { updateCreCustomerProfile } from '../src/controllers/customerController.js';

function createResponse() {
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

async function withCustomerMocks(overrides, run) {
  const originals = Object.fromEntries(Object.keys(overrides).map((method) => [method, prisma.customer[method]]));
  for (const [method, implementation] of Object.entries(overrides)) {
    prisma.customer[method] = implementation;
  }
  try {
    await run();
  } finally {
    for (const [method, implementation] of Object.entries(originals)) {
      prisma.customer[method] = implementation;
    }
  }
}

const profile = {
  fullName: 'Updated Customer',
  mobileNumber: '9876543210',
  email: 'customer@example.com',
  address: '12 Main Road',
  city: 'Visakhapatnam',
  pin: '530046',
};

test('CRE can save contact details only for a customer with a vehicle assigned in their CCM', async () => {
  let updateArgs;
  const savedCustomer = { id: 'customer-1', ...profile };
  await withCustomerMocks({
    findFirst: async (args) => {
      assert.deepEqual(args.where, {
        id: 'customer-1',
        vehicles: {
          some: {
            ccmId: 'ccm-a',
            OR: [
              { allocations: { some: { creId: 'cre-a', ccmId: 'ccm-a', status: 'assigned' } } },
              { masterCallListEntries: { some: { ownerUserId: 'cre-a', ccmId: 'ccm-a' } } },
            ],
          },
        },
      });
      return { id: 'customer-1', mobileNumber: null };
    },
    updateMany: async (args) => {
      updateArgs = args;
      return { count: 1 };
    },
    findUnique: async () => savedCustomer,
  }, async () => {
    const res = createResponse();
    await updateCreCustomerProfile({
      user: { id: 'cre-a', role: 'CRE', ccmId: 'ccm-a' },
      params: { id: 'customer-1' },
      body: profile,
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.customer, savedCustomer);
    assert.deepEqual(updateArgs.where, { id: 'customer-1', mobileNumber: null });
    assert.deepEqual(updateArgs.data, profile);
  });
});

test('customer profile editing rejects non-CRE callers and unsupported fields', async () => {
  let databaseCalled = false;
  await withCustomerMocks({
    findFirst: async () => { databaseCalled = true; },
  }, async () => {
    const forbidden = createResponse();
    await updateCreCustomerProfile({
      user: { id: 'ccm-a', role: 'CCM', ccmId: 'ccm-a' },
      params: { id: 'customer-1' },
      body: profile,
    }, forbidden);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(databaseCalled, false);

    const invalid = createResponse();
    await updateCreCustomerProfile({
      user: { id: 'cre-a', role: 'CRE', ccmId: 'ccm-a' },
      params: { id: 'customer-1' },
      body: { ...profile, ccmId: 'ccm-b' },
    }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(databaseCalled, false);
  });
});

test('profile update requires a phone number and validates email and field lengths', async () => {
  let databaseCalled = false;
  await withCustomerMocks({
    findFirst: async () => { databaseCalled = true; },
  }, async () => {
    for (const body of [
      { ...profile, mobileNumber: '' },
      { ...profile, mobileNumber: 'no phone' },
      { ...profile, email: 'invalid' },
      { ...profile, address: 'x'.repeat(501) },
    ]) {
      const res = createResponse();
      await updateCreCustomerProfile({
        user: { id: 'cre-a', role: 'CRE', ccmId: 'ccm-a' },
        params: { id: 'customer-1' },
        body,
      }, res);
      assert.equal(res.statusCode, 400);
    }
  });
  assert.equal(databaseCalled, false);
});

test('profile update is unavailable once a phone number is already on file', async () => {
  let writeCalled = false;
  await withCustomerMocks({
    findFirst: async () => ({ id: 'customer-1', mobileNumber: '5550100' }),
    updateMany: async () => { writeCalled = true; return { count: 1 }; },
  }, async () => {
    const res = createResponse();
    await updateCreCustomerProfile({
      user: { id: 'cre-a', role: 'CRE', ccmId: 'ccm-a' },
      params: { id: 'customer-1' },
      body: profile,
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(writeCalled, false);
  });
});

test('simultaneous profile saves cannot overwrite a phone number entered by another CRE', async () => {
  await withCustomerMocks({
    findFirst: async () => ({ id: 'customer-1', mobileNumber: null }),
    updateMany: async () => ({ count: 0 }),
  }, async () => {
    const res = createResponse();
    await updateCreCustomerProfile({
      user: { id: 'cre-a', role: 'CRE', ccmId: 'ccm-a' },
      params: { id: 'customer-1' },
      body: profile,
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, 'This profile was updated already. Reload it to view the saved details.');
  });
});
