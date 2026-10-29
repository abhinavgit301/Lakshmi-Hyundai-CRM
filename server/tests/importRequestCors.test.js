import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import app from '../src/app.js';

test('import request preflight allows the Idempotency-Key header', async (context) => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/imports/repair-orders`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://crm.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,idempotency-key',
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('access-control-allow-headers') || '', /Idempotency-Key/i);
});
