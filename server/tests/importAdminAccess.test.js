import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET || 'import-route-test-secret';
process.env.JWT_SECRET = jwtSecret;
const [{ default: app }, { prisma }] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/prisma.js'),
]);

test('a non-Admin cannot recover an import through the authenticated API route', async (context) => {
  const originalFindUnique = prisma.user.findUnique;
  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    role: 'CRE',
    status: 'active',
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    prisma.user.findUnique = originalFindUnique;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const token = jwt.sign({ sub: 'cre-user' }, jwtSecret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/imports/batch-1/recover`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).message, 'You do not have permission to access this area.');
});
