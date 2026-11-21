import test from 'node:test';
import assert from 'node:assert/strict';
import { iterateByIdBatches, readByIdBatches } from '../src/utils/readByIdBatches.js';

test('ID lookups are deduplicated and bounded without changing per-ID result ordering', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `id-${index}`);
  const batches = [];
  const rows = await readByIdBatches([...ids, ids[0]], async (batch) => {
    batches.push(batch);
    return batch.flatMap((id) => [{ id, order: 1 }, { id, order: 2 }]);
  });
  assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 1]);
  assert.equal(rows.length, 2002);
  assert.deepEqual(rows.slice(-2), [{ id: 'id-1000', order: 1 }, { id: 'id-1000', order: 2 }]);
  assert.deepEqual(await readByIdBatches([], () => assert.fail('empty read')), []);
});

test('ID batch lookup propagates a later query failure', async () => {
  const error = new Error('lookup failed');
  let queries = 0;
  await assert.rejects(readByIdBatches(Array.from({ length: 501 }, (_, i) => String(i)), async () => {
    if (++queries === 2) throw error;
    return [];
  }), (actual) => actual === error);
  assert.equal(queries, 2);
});

test('ID batch iterator yields each batch before reading the next', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => String(i));
  let queries = 0;
  const iterator = iterateByIdBatches(ids.values(), async (batch) => {
    queries += 1;
    return batch;
  });
  const first = await iterator.next();
  assert.equal(queries, 1);
  assert.equal(first.value.ids.length, 500);
  assert.deepEqual(first.value.rows, first.value.ids);
  const second = await iterator.next();
  assert.equal(queries, 2);
  assert.deepEqual(second.value.ids, ['500']);
  assert.equal((await iterator.next()).done, true);
});
