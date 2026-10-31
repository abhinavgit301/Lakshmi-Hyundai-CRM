import test from 'node:test';
import assert from 'node:assert/strict';
import { clearStaleMasterCallListOwner } from '../src/utils/allocationAccess.js';

const allocation = {
  id: 'allocation-1',
  vehicleId: 'vehicle-1',
  creId: 'cre-old',
  ccmId: 'ccm-1',
  status: 'assigned',
  vehicle: { vin: 'VIN-1' },
};

function createTransaction({ activeAllocations = [], ownerUserId = 'cre-old' } = {}) {
  const calls = { findActive: 0, findOwner: 0, updates: [] };
  return {
    calls,
    allocation: {
      findMany: async () => {
        calls.findActive += 1;
        return activeAllocations;
      },
    },
    masterCallList: {
      findFirst: async () => {
        calls.findOwner += 1;
        return { id: 'call-list-1', ownerUserId };
      },
      updateMany: async (args) => {
        calls.updates.push(args);
        return { count: 1 };
      },
    },
    creAssignmentHistory: {
      create: async () => ({}),
    },
  };
}

for (const status of ['cancelled', 'completed']) {
  test(`status-only ${status} removes the departing CRE's call-list access`, async () => {
    const transaction = createTransaction();

    await clearStaleMasterCallListOwner(transaction, {
      allocation,
      update: { status },
      ccmId: 'ccm-1',
    });

    assert.deepEqual(transaction.calls.updates, [{
      where: { vin: 'VIN-1', ccmId: 'ccm-1', ownerUserId: 'cre-old' },
      data: { ownerUserId: null },
    }]);
  });
}

test('a remaining active allocation keeps its CRE ownership grant', async () => {
  const transaction = createTransaction({ activeAllocations: [{ creId: 'cre-old' }] });

  await clearStaleMasterCallListOwner(transaction, {
    allocation,
    update: { status: 'completed' },
    ccmId: 'ccm-1',
  });

  assert.deepEqual(transaction.calls.updates, []);
});

test('a remaining active allocation transfers the stale owner to its CRE', async () => {
  const transaction = createTransaction({ activeAllocations: [{ creId: 'cre-next' }] });

  await clearStaleMasterCallListOwner(transaction, {
    allocation,
    update: { status: 'cancelled' },
    ccmId: 'ccm-1',
  });

  assert.deepEqual(transaction.calls.updates[0].data, { ownerUserId: 'cre-next' });
});

test('a separate Master Call List owner is not overwritten when an allocation ends', async () => {
  const transaction = createTransaction({ ownerUserId: 'cre-assigned-directly' });

  await clearStaleMasterCallListOwner(transaction, {
    allocation,
    update: { status: 'cancelled' },
    ccmId: 'ccm-1',
  });

  assert.deepEqual(transaction.calls.updates, []);
});

test('reassignment leaves the call-list owner update to the allocation reassignment path', async () => {
  const transaction = createTransaction();

  await clearStaleMasterCallListOwner(transaction, {
    allocation,
    update: { creId: 'cre-next', status: 'assigned' },
    ccmId: 'ccm-1',
  });

  assert.equal(transaction.calls.findActive, 0);
  assert.equal(transaction.calls.findOwner, 0);
  assert.deepEqual(transaction.calls.updates, []);
});
