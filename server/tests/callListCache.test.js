import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  cachedCallList,
  callListCacheMiddleware,
  invalidateCallListCache,
} from '../src/utils/callListCache.js';

test('call list cache reuses results and shares in-flight loads', async () => {
  invalidateCallListCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { calls };
  };
  const [first, second] = await Promise.all([cachedCallList('k', loader), cachedCallList('k', loader)]);
  assert.equal(first, second);
  assert.equal(await cachedCallList('k', loader), first);
  assert.equal(calls, 1);
});

test('call list cache keys stay separate', async () => {
  invalidateCallListCache();
  const a = await cachedCallList('a', async () => 'A');
  const b = await cachedCallList('b', async () => 'B');
  assert.deepEqual([a, b], ['A', 'B']);
});

test('a successful write request clears the call list cache', async () => {
  invalidateCallListCache();
  let calls = 0;
  const loader = async () => ({ calls: ++calls });
  await cachedCallList('k', loader);

  const res = new EventEmitter();
  res.statusCode = 200;
  callListCacheMiddleware({ method: 'POST' }, res, () => {});
  res.emit('finish');

  await cachedCallList('k', loader);
  assert.equal(calls, 2);
});

test('failed writes and reads keep the cache', async () => {
  invalidateCallListCache();
  let calls = 0;
  const loader = async () => ({ calls: ++calls });
  await cachedCallList('k', loader);

  const failed = new EventEmitter();
  failed.statusCode = 500;
  callListCacheMiddleware({ method: 'POST' }, failed, () => {});
  failed.emit('finish');
  const read = new EventEmitter();
  read.statusCode = 200;
  callListCacheMiddleware({ method: 'GET' }, read, () => {});
  read.emit('finish');

  await cachedCallList('k', loader);
  assert.equal(calls, 1);
});
