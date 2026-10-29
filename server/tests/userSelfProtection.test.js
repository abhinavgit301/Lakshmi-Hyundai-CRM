import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET || 'user-self-protection-test-secret';
process.env.JWT_SECRET = jwtSecret;
process.env.DATABASE_URL ||= 'postgresql://test-only.invalid/test';

const [{ default: app }, { prisma }] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/prisma.js'),
]);

test('authenticated API rejects self-deactivation and self-deletion using JWT identity', async (context) => {
  const originalFindUnique = prisma.user.findUnique;
  const adminId = 'jwt-admin-self-protection';
  prisma.user.findUnique = async ({ where }) => (
    where.id === adminId
      ? { id: adminId, role: 'ADMIN', status: 'active' }
      : null
  );

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    prisma.user.findUnique = originalFindUnique;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  const token = jwt.sign({ sub: adminId }, jwtSecret);
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/users/${adminId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const deactivateResponse = await fetch(`${baseUrl}/status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'inactive', userId: 'different-user' }),
  });
  assert.equal(deactivateResponse.status, 403);
  assert.equal((await deactivateResponse.json()).message, 'You cannot deactivate your own account.');

  const deleteResponse = await fetch(baseUrl, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ userId: 'different-user' }),
  });
  assert.equal(deleteResponse.status, 403);
  assert.equal((await deleteResponse.json()).message, 'You cannot delete your own account.');
});
