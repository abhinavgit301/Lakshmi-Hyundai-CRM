import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/config/prisma.js';
import { authMiddleware } from '../src/middleware/authMiddleware.js';
import { createUser, deleteManagedUser, updateManagedUser, updateUserStatus, assignUserToCcm } from '../src/controllers/userController.js';
import { evictAllAuthUsers, getAuthCacheStats, loadAuthUser, resetAuthCacheForTests } from '../src/utils/authUserCache.js';

const SECRET = process.env.JWT_SECRET || 'local-dev-secret';
const token = (sub) => jwt.sign({ sub }, SECRET, { expiresIn: '5m' });

function makeRes() {
  return {
    statusCode: 200,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function authenticate(sub) {
  const res = makeRes();
  let nextCalled = false;
  const req = { headers: { authorization: `Bearer ${token(sub)}` }, cookies: {} };
  await authMiddleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

async function withUserTable(initial, fn) {
  const original = prisma.user.findUnique;
  const state = { row: initial, lookups: 0 };
  prisma.user.findUnique = async ({ where } = {}) => {
    state.lookups += 1;
    return state.row && (!where?.id || where.id === state.row.id) ? { ...state.row } : null;
  };
  resetAuthCacheForTests();
  try {
    await fn(state);
  } finally {
    prisma.user.findUnique = original;
    delete process.env.AUTH_CACHE_TTL_SECONDS;
    resetAuthCacheForTests();
  }
}

const activeCre = { id: 'u1', role: 'CRE', status: 'active', ccmId: 'ccm-a', freeServiceEnabled: false };

test('cache is disabled by default and every request looks the user up', async () => {
  await withUserTable(activeCre, async (state) => {
    await authenticate('u1');
    await authenticate('u1');
    assert.equal(state.lookups, 2);
    assert.equal(getAuthCacheStats().enabled, false);
  });
});

test('when enabled, repeated requests reuse the lookup and still receive the normalised user', async () => {
  await withUserTable(activeCre, async (state) => {
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    const first = await authenticate('u1');
    const second = await authenticate('u1');
    assert.equal(state.lookups, 1);
    assert.equal(second.nextCalled, true);
    assert.deepEqual(second.req.user, first.req.user);
    assert.equal(second.req.user.role, 'CRE');
    assert.equal(second.req.user.ccmId, 'ccm-a');
    assert.equal(getAuthCacheStats().hits, 1);
  });
});

test('JWT verification still runs on every cached request', async () => {
  await withUserTable(activeCre, async () => {
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    await authenticate('u1');
    const res = makeRes();
    await authMiddleware({ headers: { authorization: 'Bearer not-a-jwt' }, cookies: {} }, res, () => {});
    assert.equal(res.statusCode, 401);
    const missing = makeRes();
    await authMiddleware({ headers: {}, cookies: {} }, missing, () => {});
    assert.equal(missing.statusCode, 401);
  });
});

test('inactive and missing users are never cached', async () => {
  await withUserTable({ ...activeCre, status: 'inactive' }, async (state) => {
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { res, nextCalled } = await authenticate('u1');
      assert.equal(res.statusCode, 401);
      assert.equal(nextCalled, false);
    }
    assert.equal(state.lookups, 2);
    state.row = null;
    const { res } = await authenticate('u1');
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'User not found.');
    assert.equal(getAuthCacheStats().entries, 0);
  });
});

test('entries expire after the TTL', async () => {
  await withUserTable(activeCre, async (state) => {
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      await authenticate('u1');
      offset = 2900;
      await authenticate('u1');
      assert.equal(state.lookups, 1);
      offset = 3100;
      await authenticate('u1');
      assert.equal(state.lookups, 2);
    } finally {
      Date.now = realNow;
    }
  });
});

test('a lookup that started before an eviction is not stored afterwards', async () => {
  process.env.AUTH_CACHE_TTL_SECONDS = '3';
  resetAuthCacheForTests();
  try {
    let release;
    const slow = loadAuthUser('u9', () => new Promise((resolve) => { release = () => resolve({ id: 'u9', status: 'active' }); }));
    evictAllAuthUsers();
    release();
    await slow;
    assert.equal(getAuthCacheStats().entries, 0);
  } finally {
    delete process.env.AUTH_CACHE_TTL_SECONDS;
    resetAuthCacheForTests();
  }
});

test('the TTL is capped so a typo cannot cache users for minutes', async () => {
  await withUserTable(activeCre, async (state) => {
    process.env.AUTH_CACHE_TTL_SECONDS = '86400';
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      await authenticate('u1');
      offset = 31000;
      await authenticate('u1');
      assert.equal(state.lookups, 2);
    } finally {
      Date.now = realNow;
    }
  });
});

test('every user write handler evicts cached users, even when it fails validation', async () => {
  await withUserTable(activeCre, async (state) => {
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    const handlers = [
      ['createUser', createUser, { body: {} }],
      ['updateManagedUser', updateManagedUser, { params: { id: 'missing' }, body: {} }],
      ['updateUserStatus', updateUserStatus, { params: { id: 'missing' }, body: { status: 'inactive' }, user: { id: 'admin' } }],
      ['assignUserToCcm', assignUserToCcm, { params: { id: 'missing' }, body: {}, user: { id: 'admin' } }],
      ['deleteManagedUser', deleteManagedUser, { params: { id: 'missing' }, user: { id: 'admin' } }],
    ];
    const originalWrite = prisma.user.findFirst;
    prisma.user.findFirst = async () => null;
    try {
      for (const [name, handler, req] of handlers) {
        await authenticate('u1');
        assert.equal(getAuthCacheStats().entries, 1, `${name}: primed`);
        try { await handler({ query: {}, ...req }, makeRes()); } catch { /* the eviction must hold on failure too */ }
        assert.equal(getAuthCacheStats().entries, 0, `${name}: evicted`);
      }
    } finally {
      prisma.user.findFirst = originalWrite;
    }
    assert.ok(state.lookups >= handlers.length);
  });
});

test('after a status write the next request sees the change immediately', async () => {
  await withUserTable(activeCre, async (state) => {
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    assert.equal((await authenticate('u1')).nextCalled, true);
    state.row = { ...activeCre, status: 'inactive' };
    evictAllAuthUsers();
    const after = await authenticate('u1');
    assert.equal(after.res.statusCode, 401);
    assert.equal(after.res.body.message, 'Account is inactive.');
  });
});
