import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { login } from '../src/controllers/authController.js';

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

async function withLoginMocks(findFirst, compare, run) {
  const originalFindFirst = prisma.user.findFirst;
  const originalCompare = bcrypt.compare;
  prisma.user.findFirst = findFirst;
  bcrypt.compare = compare;
  try {
    await run();
  } finally {
    prisma.user.findFirst = originalFindFirst;
    bcrypt.compare = originalCompare;
  }
}

test('unknown users receive the same password verification work and failure response', async () => {
  let compareCount = 0;
  await withLoginMocks(
    async () => null,
    async (password, hash) => {
      compareCount += 1;
      assert.equal(password, 'wrong-password');
      assert.match(hash, /^\$2[aby]\$10\$/);
      return false;
    },
    async () => {
      const res = createResponse();
      await login({ body: { username: 'unknown', password: 'wrong-password' } }, res);
      assert.equal(compareCount, 1);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { message: 'Invalid email or password.' });
    },
  );
});

test('inactive users use the same password verification path and failure response', async () => {
  let compareCount = 0;
  await withLoginMocks(
    async () => ({ status: 'inactive', password: 'stored-hash' }),
    async (_password, hash) => {
      compareCount += 1;
      assert.notEqual(hash, 'stored-hash');
      return false;
    },
    async () => {
      const res = createResponse();
      await login({ body: { username: 'inactive', password: 'wrong-password' } }, res);
      assert.equal(compareCount, 1);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.body, { message: 'Invalid email or password.' });
    },
  );
});
