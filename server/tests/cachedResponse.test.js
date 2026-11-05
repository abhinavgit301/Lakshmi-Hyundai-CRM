import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidateCallListCache, withCachedResponse } from '../src/utils/callListCache.js';

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('withCachedResponse runs the loader once per user and query until invalidated', async () => {
  invalidateCallListCache();
  let calls = 0;
  const handler = withCachedResponse('test', async (req, res) => {
    calls += 1;
    res.status(201).json({ n: calls });
  });
  const req = { user: { id: 'u1', role: 'CCM', ccmId: 'c1' }, query: { a: '1' } };

  const first = mockRes();
  await handler(req, first);
  const second = mockRes();
  await handler(req, second);
  assert.equal(calls, 1);
  assert.deepEqual(second.body, { n: 1 });
  assert.equal(second.statusCode, 201);

  const other = mockRes();
  await handler({ ...req, user: { ...req.user, id: 'u2' } }, other);
  assert.equal(calls, 2);

  invalidateCallListCache();
  await handler(req, mockRes());
  assert.equal(calls, 3);
});
