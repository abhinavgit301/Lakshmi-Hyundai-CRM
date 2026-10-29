import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

process.env.DATABASE_URL ||= 'postgresql://test-only.invalid/test';
process.env.JWT_SECRET ||= 'user-controller-test-secret';

const [{ prisma }, { createUser }, { login }, { authMiddleware, requireRole }] = await Promise.all([
  import('../src/config/prisma.js'),
  import('../src/controllers/userController.js'),
  import('../src/controllers/authController.js'),
  import('../src/middleware/authMiddleware.js'),
]);

after(async () => {
  await prisma.$disconnect();
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    cookie(...args) {
      this.cookies.push(args);
      return this;
    },
  };
}

function requestForUser(user, role = 'ADMIN') {
  return {
    body: { ...user },
    user: { id: 'existing-admin', role },
  };
}

function replaceMethod(t, target, methodName, implementation) {
  const original = target[methodName];
  target[methodName] = implementation;
  t.after(() => {
    target[methodName] = original;
  });
}

function setupUserStore(t) {
  const users = [];
  replaceMethod(t, prisma.user, 'findUnique', async ({ where }) => (
    users.find(({ username }) => username === where.username) || null
  ));
  replaceMethod(t, prisma.user, 'findFirst', async ({ where }) => {
    if (where?.OR) {
      return users.find((user) => where.OR.some((condition) => (
        condition.username === user.username || condition.email === user.email
      ))) || null;
    }
    if (where?.id && where.role === 'GM') return { id: where.id };
    if (where?.role === 'CCM' && where.status === 'active') {
      return users.find((user) => user.role === 'CCM' && user.ccmId === where.ccmId && user.status === 'active') || null;
    }
    return null;
  });
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    user: {
      findMany: async () => [],
      create: async ({ data }) => {
        const user = {
          id: `created-${users.length + 1}`,
          ...data,
          email: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
        users.push(user);
        return user;
      },
    },
    $queryRaw: async () => [],
    masterCallList: { findMany: async () => [] },
    allocation: { findMany: async () => [] },
  }));
  return users;
}

test('Admin can create an ADMIN account that can log in; response omits password hash', async (t) => {
  const users = setupUserStore(t);
  const newAdmin = {
    name: 'New Administrator',
    username: 'new.admin',
    password: 'a-strong-password',
    role: 'ADMIN',
  };
  const createResponse = responseRecorder();

  await createUser(requestForUser(newAdmin), createResponse);

  assert.equal(createResponse.statusCode, 201);
  assert.equal(createResponse.body.user.role, 'ADMIN');
  assert.equal(createResponse.body.user.username, newAdmin.username);
  assert.equal(Object.hasOwn(createResponse.body.user, 'password'), false);
  assert.equal(await bcrypt.compare(newAdmin.password, users[0].password), true);

  const duplicateResponse = responseRecorder();
  await createUser(requestForUser(newAdmin), duplicateResponse);
  assert.equal(duplicateResponse.statusCode, 409);

  const loginResponse = responseRecorder();
  await login({ body: { username: newAdmin.username, password: newAdmin.password } }, loginResponse);
  assert.equal(loginResponse.statusCode, 200);
  assert.equal(loginResponse.body.user.role, 'Admin');
  assert.equal(Object.hasOwn(loginResponse.body.user, 'password'), false);
  assert.equal(loginResponse.cookies.length, 1);
  const token = jwt.verify(loginResponse.body.token, process.env.JWT_SECRET);
  assert.equal(token.sub, users[0].id);
  assert.equal(token.role, 'Admin');
});

test('creation continues to accept GM, CCM, CRE, and Free-Service CRE roles', async (t) => {
  const users = setupUserStore(t);
  const roleCases = [
    { role: 'GM' },
    { role: 'CCM', gmId: 'existing-gm', ccmId: 'test-ccm' },
    { role: 'CRE', ccmId: 'test-ccm' },
    { role: 'FREE_SERVICE_CRE', ccmId: 'test-ccm' },
  ];

  for (const [index, extra] of roleCases.entries()) {
    if (extra.role === 'CCM') {
      users.push({
        id: 'existing-gm',
        role: 'GM',
        status: 'active',
      });
    } else if (['CRE', 'FREE_SERVICE_CRE'].includes(extra.role)) {
      users.push({
        id: 'existing-ccm',
        role: 'CCM',
        ccmId: 'test-ccm',
        status: 'active',
      });
    }
    const response = responseRecorder();
    await createUser(requestForUser({
      name: `${extra.role} User`,
      username: `${extra.role.toLowerCase()}user${index}`,
      password: 'a-strong-password',
      ...extra,
    }), response);
    assert.equal(response.statusCode, 201, extra.role);
    assert.equal(response.body.user.role, extra.role);
  }
});

test('server role authorization rejects unauthenticated and non-Admin user creation requests', async () => {
  const unauthenticatedResponse = responseRecorder();
  let continued = false;
  await authMiddleware({ headers: {}, cookies: {} }, unauthenticatedResponse, () => { continued = true; });
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(continued, false);

  for (const role of ['GM', 'CCM', 'CRE']) {
    const response = responseRecorder();
    let nextCalled = false;
    requireRole('Admin')({ user: { role } }, response, () => { nextCalled = true; });
    assert.equal(response.statusCode, 403, role);
    assert.equal(nextCalled, false);
  }
});

test('username uniqueness race returns a conflict instead of a server error', async (t) => {
  replaceMethod(t, prisma.user, 'findUnique', async () => null);
  replaceMethod(t, prisma, '$transaction', async () => {
    throw { code: 'P2002', meta: { target: ['username'] } };
  });
  const response = responseRecorder();
  await createUser(requestForUser({
    name: 'Racing Admin',
    username: 'racing.admin',
    password: 'a-strong-password',
    role: 'ADMIN',
  }), response);
  assert.equal(response.statusCode, 409);
});

test('unsupported roles are rejected by the user-creation API', async () => {
  const response = responseRecorder();
  await createUser(requestForUser({
    name: 'Invalid Role User',
    username: 'invalid.role',
    password: 'a-strong-password',
    role: 'SUPERADMIN',
  }), response);
  assert.equal(response.statusCode, 400);
});
