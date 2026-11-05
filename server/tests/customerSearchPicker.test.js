import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { getCustomers } from '../src/controllers/recordsController.js';

function makeRes() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function withStubs(findMany, count, run) {
  const originals = [prisma.customer.findMany, prisma.customer.count];
  prisma.customer.findMany = findMany;
  prisma.customer.count = count;
  try { await run(); } finally { [prisma.customer.findMany, prisma.customer.count] = originals; }
}

test('customer search and paging are executed by the database with scope preserved', async () => {
  const calls = [];
  await withStubs(async (args) => { calls.push(args); return []; }, async () => 0, async () => {
    const res = makeRes();
    await getCustomers({ user: { role: 'CCM', ccmId: 'ccm-a' }, query: { limit: '20', offset: '40', search: ' Ravi ' } }, res);
    assert.equal(res.statusCode, 200);
    const [idQuery] = calls;
    assert.equal(idQuery.skip, 40);
    assert.equal(idQuery.take, 20);
    assert.deepEqual(idQuery.where.AND[0].OR[0], { ccmId: 'ccm-a' });
    const search = idQuery.where.AND[1].OR;
    assert.deepEqual(search[0], { fullName: { contains: 'Ravi', mode: 'insensitive' } });
    // Vehicle matches must stay inside the caller's CCM.
    assert.deepEqual(search[3].vehicles.some.AND[0], { ccmId: 'ccm-a' });
  });
});

test('picker projection selects only picker fields and keeps the customers shape', async () => {
  let args;
  await withStubs(async (a) => {
    args = a;
    return [{ id: 'c1', fullName: 'Ravi', mobileNumber: '9876543210', ccmId: 'ccm-a', vehicles: [{ id: 'v1', vin: 'VIN', model: 'i20', registrationNumber: 'TS1', ccmId: 'ccm-a' }] }];
  }, async () => 3, async () => {
    const res = makeRes();
    await getCustomers({ user: { role: 'ADMIN' }, query: { limit: '1', offset: '0', fields: 'picker' } }, res);
    assert.deepEqual(Object.keys(args.select).sort(), ['ccmId', 'fullName', 'id', 'mobileNumber', 'vehicles']);
    assert.equal(args.select.visits, undefined);
    const [customer] = res.body.customers;
    assert.equal(customer.name, 'Ravi');
    assert.equal(customer.vehicles[0].id, 'v1');
    assert.deepEqual([res.body.total, res.body.hasMore], [3, true]);
  });
});

test('picker projection and search reject invalid input; FREE_SERVICE_CRE stays forbidden', async () => {
  await withStubs(async () => [], async () => 0, async () => {
    for (const query of [{ fields: 'picker' }, { limit: '5', offset: '0', fields: 'other' }, { search: 'x'.repeat(201) }]) {
      const res = makeRes();
      await getCustomers({ user: { role: 'ADMIN' }, query }, res);
      assert.equal(res.statusCode, 400);
    }
    const res = makeRes();
    await getCustomers({ user: { role: 'FREE_SERVICE_CRE' }, query: { limit: '5', offset: '0', fields: 'picker' } }, res);
    assert.equal(res.statusCode, 403);
  });
});
