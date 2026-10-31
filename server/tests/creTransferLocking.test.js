import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lockAndValidateCreCcmTransfer,
  lockCcmAllocationTeam,
} from '../src/utils/customerAllocation.js';

function createLockStore() {
  const tails = new Map();
  return async function lock(key) {
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(key, previous.then(() => current));
    await previous;
    return release;
  };
}

function createScenario(initialCcmId = 'ccm-old') {
  const state = {
    cre: { id: 'cre-1', role: 'CRE', ccmId: initialCcmId, status: 'active' },
    allocations: [],
    callListEntries: [],
  };
  const acquire = createLockStore();

  async function runTransaction(callback) {
    const releases = [];
    const transaction = {
      $queryRaw: async (_strings, lockName) => {
        releases.push(await acquire(lockName));
      },
      user: {
        findUnique: async () => ({ ...state.cre }),
        findFirst: async ({ where }) => (
          where.role === 'CCM' && where.status === 'active' && where.ccmId
            ? { ccmId: where.ccmId }
            : null
        ),
      },
      allocation: {
        findFirst: async ({ where }) => state.allocations.find((allocation) => (
          allocation.creId === where.creId && allocation.status === where.status
        )) || null,
      },
      masterCallList: {
        findFirst: async ({ where }) => state.callListEntries.find((entry) => entry.ownerUserId === where.ownerUserId) || null,
      },
    };
    try {
      return await callback(transaction);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async function transfer(targetCcmId, beforeCommit = async () => {}) {
    return runTransaction(async (transaction) => {
      const validation = await lockAndValidateCreCcmTransfer(transaction, {
        creId: state.cre.id,
        expectedOldCcmId: 'ccm-old',
        newCcmId: targetCcmId,
      });
      if (validation.error) return validation.error;
      await beforeCommit();
      state.cre.ccmId = targetCcmId;
      return 'committed';
    });
  }

  async function allocate(ccmId, beforeCreate = async () => {}) {
    return runTransaction(async (transaction) => {
      await lockCcmAllocationTeam(transaction, ccmId);
      if (state.cre.ccmId !== ccmId || state.cre.status !== 'active') return 'cre-not-in-team';
      await beforeCreate();
      state.allocations.push({ creId: state.cre.id, ccmId, status: 'assigned' });
      return 'committed';
    });
  }

  return { state, runTransaction, transfer, allocate };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a transfer that locks first prevents a later allocation under the old CCM', async () => {
  const scenario = createScenario();
  const validated = deferred();
  const continueTransfer = deferred();
  const transfer = scenario.transfer('ccm-new', async () => {
    validated.resolve();
    await continueTransfer.promise;
  });
  await validated.promise;
  const allocation = scenario.allocate('ccm-old');
  continueTransfer.resolve();

  assert.equal(await transfer, 'committed');
  assert.equal(await allocation, 'cre-not-in-team');
  assert.equal(scenario.state.allocations.length, 0);
});

test('an allocation that locks first causes a later transfer to reject without moving the CRE', async () => {
  const scenario = createScenario();
  const entered = deferred();
  const continueAllocation = deferred();
  const allocation = scenario.allocate('ccm-old', async () => {
    entered.resolve();
    await continueAllocation.promise;
  });
  await entered.promise;
  const transfer = scenario.transfer('ccm-new');
  continueAllocation.resolve();

  assert.equal(await allocation, 'committed');
  assert.equal(await transfer, 'active-assignments');
  assert.equal(scenario.state.cre.ccmId, 'ccm-old');
});

test('concurrent transfer and allocation serialize on the same CCM allocation lock', async () => {
  const scenario = createScenario();
  const results = await Promise.all([
    scenario.transfer('ccm-new'),
    scenario.allocate('ccm-old'),
  ]);

  assert.equal(results.filter((result) => result === 'committed').length, 1);
  assert.ok(['cre-not-in-team', 'active-assignments'].includes(results.find((result) => result !== 'committed')));
  assert.equal(
    scenario.state.cre.ccmId === 'ccm-old' && scenario.state.allocations.length === 1
      || scenario.state.cre.ccmId === 'ccm-new' && scenario.state.allocations.length === 0,
    true,
  );
});

test('two simultaneous CCM transfers allow only one stale-source transfer to commit', async () => {
  const scenario = createScenario();
  const results = await Promise.all([
    scenario.transfer('ccm-target-a'),
    scenario.transfer('ccm-target-b'),
  ]);

  assert.equal(results.filter((result) => result === 'committed').length, 1);
  assert.equal(results.filter((result) => result === 'cre-changed').length, 1);
  assert.ok(['ccm-target-a', 'ccm-target-b'].includes(scenario.state.cre.ccmId));
});

test('transfer validation failure leaves the transaction state unchanged', async () => {
  const scenario = createScenario();
  scenario.state.callListEntries.push({ ownerUserId: 'cre-1' });
  const result = await scenario.transfer('ccm-new');

  assert.equal(result, 'active-assignments');
  assert.equal(scenario.state.cre.ccmId, 'ccm-old');
  assert.equal(scenario.state.allocations.length, 0);
});

test('a same-CCM assignment is a no-op even when the CRE already has work', async () => {
  const scenario = createScenario();
  scenario.state.allocations.push({ creId: 'cre-1', ccmId: 'ccm-old', status: 'assigned' });

  assert.equal(await scenario.transfer('ccm-old'), 'committed');
  assert.equal(scenario.state.cre.ccmId, 'ccm-old');
  assert.equal(scenario.state.allocations.length, 1);
});
