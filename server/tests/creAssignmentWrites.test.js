import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillCreAssignmentProjectionPage, reconcileCreAssignmentProjection, reconcileCreAssignmentProjectionPage, withCreAssignmentProjectionWrites } from '../src/utils/creAssignmentProjection.js';

test('projection write primitive rejects incomplete inputs before opening a transaction', async () => {
  const db = { $transaction: () => assert.fail('must not start transaction') };
  for (const ids of [null, [], [''], ['  '], [null], ['valid', 1]]) {
    await assert.rejects(withCreAssignmentProjectionWrites(db, ids, () => {}), /non-empty vehicle IDs/);
  }
  await assert.rejects(withCreAssignmentProjectionWrites(db, ['valid'], null), /mutation callback/);
});

test('projection backfill rejects invalid cursors and batch sizes before querying', async () => {
  const db = { vehicle: { findMany: () => assert.fail('must not query') } };
  for (const afterId of ['', ' ', 7]) {
    await assert.rejects(backfillCreAssignmentProjectionPage(db, { afterId }), /cursor/);
  }
  for (const limit of [0, -1, 501, 1.5, '10']) {
    await assert.rejects(backfillCreAssignmentProjectionPage(db, { limit }), /page size/);
  }
});

test('scoped projection reconciliation rejects invalid vehicle sets', async () => {
  const db = { $queryRaw: () => assert.fail('must not query') };
  for (const vehicleIds of [[], [null], [''], 'vehicle', Array(501).fill('vehicle')]) {
    await assert.rejects(reconcileCreAssignmentProjection(db, { vehicleIds }), /1 and 500 non-empty vehicle IDs/);
  }
});

test('projection reconciliation pages reject invalid cursors and sizes before opening a transaction', async () => {
  const db = { $transaction: () => assert.fail('must not start transaction') };
  for (const afterId of ['', ' ', 7]) {
    await assert.rejects(reconcileCreAssignmentProjectionPage(db, { afterId }), /cursor/);
  }
  for (const limit of [0, -1, 501, 1.5, '10']) {
    await assert.rejects(reconcileCreAssignmentProjectionPage(db, { limit }), /page size/);
  }
});
