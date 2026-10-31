import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

process.env.DATABASE_URL ||= 'postgresql://test-only.invalid/test';
process.env.JWT_SECRET ||= 'user-controller-test-secret';

const [
  { prisma },
  { createUser, updateManagedUser, updateUserStatus, deleteManagedUser },
  { login },
  { authMiddleware, requireRole },
] = await Promise.all([
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
    users.find((user) => (where.id && user.id === where.id)
      || (where.username && user.username === where.username)) || null
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
      update: async ({ where, data }) => {
        const index = users.findIndex((user) => user.id === where.id);
        if (index < 0) throw new Error('Test user does not exist.');
        users[index] = { ...users[index], ...data };
        return users[index];
      },
      delete: async ({ where }) => {
        const index = users.findIndex((user) => user.id === where.id);
        if (index < 0) throw new Error('Test user does not exist.');
        return users.splice(index, 1)[0];
      },
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
    auditLog: { create: async () => ({}) },
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
    throw { code: 'P2002', meta: { target: 'users_username_key' } };
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

test('database-backed login and JWT authorization preserve every supported user role', async (t) => {
  const users = setupUserStore(t);
  const password = 'a-strong-password';
  const passwordHash = await bcrypt.hash(password, 10);
  const roles = ['ADMIN', 'GM', 'CCM', 'CRE', 'FREE_SERVICE_CRE'];
  for (const [index, role] of roles.entries()) {
    users.push({
      id: `existing-${role.toLowerCase()}`,
      username: `${role.toLowerCase()}login`,
      email: null,
      password: passwordHash,
      role,
      status: 'active',
      ccmId: role === 'CCM' || role === 'CRE' || role === 'FREE_SERVICE_CRE' ? 'test-ccm' : null,
    });
  }

  for (const role of roles) {
    const username = `${role.toLowerCase()}login`;
    const loginResponse = responseRecorder();
    await login({ body: { username, password } }, loginResponse);
    assert.equal(loginResponse.statusCode, 200, role);
    assert.equal(loginResponse.body.user.role, role === 'ADMIN' ? 'Admin' : role);

    const middlewareResponse = responseRecorder();
    const authRequest = {
      headers: { authorization: `Bearer ${loginResponse.body.token}` },
      cookies: {},
    };
    await authMiddleware(
      authRequest,
      middlewareResponse,
      () => {},
    );
    assert.equal(middlewareResponse.statusCode, 200, role);
    assert.equal(authRequest.user.role, role === 'ADMIN' ? 'Admin' : role);
    let authorized = false;
    requireRole(role === 'ADMIN' ? 'Admin' : role)(authRequest, middlewareResponse, () => {
      authorized = true;
    });
    assert.equal(authorized, true, role);
  }

  const invalidResponse = responseRecorder();
  await login({ body: { username: 'adminlogin', password: 'incorrect-password' } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 401);
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

test('Admin can edit their own account but cannot deactivate or delete it', async (t) => {
  const users = setupUserStore(t);
  const admin = {
    id: 'existing-admin',
    name: 'Current Administrator',
    username: 'current.admin',
    email: null,
    password: await bcrypt.hash('a-strong-password', 10),
    role: 'ADMIN',
    status: 'active',
    phone: null,
    ccmId: null,
    gmId: null,
    dealerCode: null,
    freeServiceEnabled: false,
    warrantyEnabled: false,
  };
  users.push(admin);
  const request = {
    user: { id: admin.id, role: 'Admin' },
    params: { id: admin.id },
    body: { name: 'Updated Administrator', username: admin.username, role: 'ADMIN' },
  };
  const editResponse = responseRecorder();

  await updateManagedUser(request, editResponse);
  assert.equal(editResponse.body.user.name, 'Updated Administrator');
  assert.equal(editResponse.body.user.role, 'ADMIN');

  const deactivateResponse = responseRecorder();
  await updateUserStatus({
    user: { id: admin.id, role: 'Admin' },
    params: { id: admin.id },
    body: { status: 'inactive' },
  }, deactivateResponse);
  assert.equal(deactivateResponse.statusCode, 403);
  assert.equal(deactivateResponse.body.message, 'You cannot deactivate your own account.');

  const deleteResponse = responseRecorder();
  await deleteManagedUser({
    user: { id: admin.id, role: 'Admin' },
    params: { id: admin.id },
  }, deleteResponse);
  assert.equal(deleteResponse.statusCode, 403);
  assert.equal(deleteResponse.body.message, 'You cannot delete your own account.');
  assert.equal(users.find(({ id }) => id === admin.id).status, 'active');
});

test('Admin can deactivate and delete a different account', async (t) => {
  const users = setupUserStore(t);
  users.push({
    id: 'other-gm',
    name: 'Other Manager',
    username: 'other.manager',
    email: null,
    password: 'not-used',
    role: 'GM',
    status: 'active',
    ccmId: null,
    gmId: null,
    dealerCode: null,
    freeServiceEnabled: false,
    warrantyEnabled: false,
  });

  const deactivateResponse = responseRecorder();
  await updateUserStatus({
    user: { id: 'existing-admin', role: 'Admin' },
    params: { id: 'other-gm' },
    body: { status: 'inactive' },
  }, deactivateResponse);
  assert.equal(deactivateResponse.body.user.status, 'inactive');

  const deleteResponse = responseRecorder();
  await deleteManagedUser({
    user: { id: 'existing-admin', role: 'Admin' },
    params: { id: 'other-gm' },
  }, deleteResponse);
  assert.equal(deleteResponse.body.deleted, true);
  assert.equal(users.some(({ id }) => id === 'other-gm'), false);
});

test('deactivating a CRE unassigns active work for CCM review and CRE deletion is rejected', async (t) => {
  const users = setupUserStore(t);
  users.push({
    id: 'cre-to-deactivate',
    name: 'CRE User',
    username: 'cre.user',
    email: null,
    password: 'not-used',
    role: 'CRE',
    status: 'active',
    ccmId: 'ccm-1',
  });
  const history = [];
  const changes = [];
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    user: {
      update: async ({ where, data }) => {
        const user = users.find(({ id }) => id === where.id);
        Object.assign(user, data);
        return user;
      },
    },
    $queryRaw: async () => [],
    masterCallList: {
      findMany: async () => [{ id: 'call-1', ccmId: 'ccm-1', vehicle: { id: 'vehicle-1' } }],
      update: async ({ data }) => { changes.push(data); return {}; },
    },
    allocation: {
      findMany: async () => [{ id: 'allocation-1', ccmId: 'ccm-1', vehicleId: 'vehicle-1' }],
      update: async ({ data }) => { changes.push(data); return {}; },
    },
    creAssignmentHistory: {
      create: async ({ data }) => { history.push(data); return data; },
    },
    auditLog: { create: async () => ({}) },
  }));

  const deactivateResponse = responseRecorder();
  await updateUserStatus({
    user: { id: 'existing-admin', role: 'Admin' },
    params: { id: 'cre-to-deactivate' },
    body: { status: 'inactive', reason: 'Role ended' },
  }, deactivateResponse);

  assert.equal(deactivateResponse.body.user.status, 'inactive');
  assert.deepEqual(changes, [
    { ownerUserId: null, status: 'pending', assignmentNeedsReview: true },
    { creId: null },
  ]);
  assert.equal(history.length, 2);
  assert.ok(history.every((event) => event.previousCreId === 'cre-to-deactivate'
    && event.newCreId === null
    && event.actorUserId === 'existing-admin'
    && event.reason === 'Role ended'));

  const deleteResponse = responseRecorder();
  await deleteManagedUser({
    user: { id: 'existing-admin', role: 'Admin' },
    params: { id: 'cre-to-deactivate' },
  }, deleteResponse);
  assert.equal(deleteResponse.statusCode, 409);
  assert.equal(users.some(({ id }) => id === 'cre-to-deactivate'), true);

  const token = jwt.sign({ sub: 'cre-to-deactivate' }, process.env.JWT_SECRET);
  let continued = false;
  const authResponse = responseRecorder();
  await authMiddleware({
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
  }, authResponse, () => { continued = true; });
  assert.equal(authResponse.statusCode, 401);
  assert.equal(continued, false);
});
