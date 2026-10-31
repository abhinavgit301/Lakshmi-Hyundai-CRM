import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://test-only.invalid/test';

const [{ prisma }, { updateManagedUser, assignUserToCcm }] = await Promise.all([
  import('../src/config/prisma.js'),
  import('../src/controllers/userController.js'),
]);

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

function setupTransfer(t, { assignment = null, activeTarget = true, initialTarget = true } = {}) {
  const existing = {
    id: 'cre-1',
    role: 'CRE',
    ccmId: 'ccm-old',
    status: 'active',
    username: 'cre.user',
    name: 'CRE User',
    phone: null,
    dealerCode: null,
    gmId: null,
    freeServiceEnabled: false,
    warrantyEnabled: false,
  };
  const locks = [];
  let updated = null;
  replaceMethod(t, prisma.user, 'findUnique', async () => ({ ...existing }));
  replaceMethod(t, prisma.user, 'findFirst', async ({ where }) => (
    where.role === 'CCM' && where.status === 'active' && initialTarget && where.ccmId === 'ccm-new'
      ? { ccmId: 'ccm-new' }
      : null
  ));
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    $queryRaw: async (_strings, lockName) => { locks.push(lockName); },
    user: {
      findUnique: async () => ({ ...existing }),
      findFirst: async ({ where }) => (
        where.role === 'CCM' && where.status === 'active' && activeTarget
          ? { ccmId: where.ccmId }
          : null
      ),
      update: async ({ data }) => {
        updated = { ...existing, ...data, updatedAt: new Date('2026-01-01T00:00:00Z') };
        return updated;
      },
    },
    allocation: {
      findFirst: async () => assignment?.kind === 'allocation' ? { id: 'allocation-1' } : null,
    },
    masterCallList: {
      findFirst: async () => assignment?.kind === 'mcl' ? { id: 'mcl-1' } : null,
    },
  }));
  return { locks, getUpdated: () => updated };
}

test('managed-user CRE transfer locks both CCM scopes in deterministic order and revalidates in transaction', async (t) => {
  const state = setupTransfer(t);
  const response = responseRecorder();

  await updateManagedUser({
    params: { id: 'cre-1' },
    body: { ccmId: 'ccm-new' },
    user: { id: 'admin-1' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.ccmId, 'ccm-new');
  assert.deepEqual(state.locks, ['customer-allocation:ccm-new', 'customer-allocation:ccm-old']);
  assert.equal(state.getUpdated().ccmId, 'ccm-new');
});

test('direct CRE-to-CCM assignment uses the same locking and validation transaction', async (t) => {
  const state = setupTransfer(t);
  const response = responseRecorder();

  await assignUserToCcm({
    params: { id: 'cre-1' },
    body: { ccmId: 'ccm-new' },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.ccmId, 'ccm-new');
  assert.deepEqual(state.locks, ['customer-allocation:ccm-new', 'customer-allocation:ccm-old']);
});

test('transfer validation failure leaves the user unchanged and returns conflict', async (t) => {
  const state = setupTransfer(t, { assignment: { kind: 'allocation' } });
  const response = responseRecorder();

  await updateManagedUser({
    params: { id: 'cre-1' },
    body: { ccmId: 'ccm-new' },
    user: { id: 'admin-1' },
  }, response);

  assert.equal(response.statusCode, 409);
  assert.equal(state.getUpdated(), null);
});

test('transfer rejects a CCM that became inactive before transactional validation', async (t) => {
  const state = setupTransfer(t, { activeTarget: false });
  const response = responseRecorder();

  await assignUserToCcm({
    params: { id: 'cre-1' },
    body: { ccmId: 'ccm-new' },
  }, response);

  assert.equal(response.statusCode, 409);
  assert.equal(state.getUpdated(), null);
});
