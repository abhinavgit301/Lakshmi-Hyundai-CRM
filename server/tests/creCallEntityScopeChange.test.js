import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flushCreCallAggregates,
  noteCreCallEntityScopeChange,
} from '../src/utils/creCallAggregates.js';

test('entity deletion captures callers before the change and rebuilds counters in the transaction', async (t) => {
  const previous = process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
    else process.env.PERFORMANCE_AGGREGATES_MAINTAIN = previous;
  });

  const log = [];
  const transaction = {
    vehicle: {
      findMany: async ({ where }) => where.id.in.includes('vehicle-1') ? [{ customerId: 'customer-from-vehicle' }] : [],
    },
    callLog: {
      groupBy: async (args) => {
        log.push({ action: 'capture', args });
        if (args.by[0] === 'createdById') return [{ createdById: 'cre-a' }, { createdById: 'cre-b' }];
        return [];
      },
      findMany: async () => [],
    },
    $executeRaw: async () => { log.push({ action: 'lock' }); return 1; },
    creCallDaily: {
      deleteMany: async ({ where }) => { log.push({ action: 'rebuild', userId: where.userId }); return { count: 0 }; },
      createMany: async () => ({ count: 0 }),
    },
    crePerformanceSnapshot: {
      updateMany: async ({ where }) => { log.push({ action: 'dirty', where }); return { count: 1 }; },
      deleteMany: async () => ({ count: 0 }),
    },
  };

  await noteCreCallEntityScopeChange(transaction, { customerIds: ['customer-1'], vehicleIds: ['vehicle-1'] });
  const result = await flushCreCallAggregates(transaction);

  assert.deepEqual(result, { creIds: ['cre-a', 'cre-b'], changed: true });
  assert.deepEqual(log.filter((entry) => entry.action === 'rebuild').map((entry) => entry.userId), ['cre-a', 'cre-b']);
  assert.equal(log.find((entry) => entry.action === 'capture').args.where.OR.length, 3);
  assert.equal(log.some((entry) => entry.action === 'dirty'), true);
});

test('entity scope capture is a no-op when aggregate maintenance is disabled', async (t) => {
  const previous = process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'false';
  t.after(() => {
    if (previous === undefined) delete process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
    else process.env.PERFORMANCE_AGGREGATES_MAINTAIN = previous;
  });

  let queried = false;
  const transaction = { callLog: { groupBy: async () => { queried = true; return []; } } };
  await noteCreCallEntityScopeChange(transaction, { customerIds: ['customer-1'] });
  assert.equal(queried, false);
  assert.deepEqual(await flushCreCallAggregates(transaction), { creIds: [], changed: false });
});
