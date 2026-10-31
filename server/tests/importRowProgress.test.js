import test from 'node:test';
import assert from 'node:assert/strict';
import { completeImportRow } from '../src/utils/importRowProgress.js';

test('completes rows using transaction-returned evidence without rereading change logs', async () => {
  const progressUpdates = [];
  const batchUpdates = [];
  const transaction = {
    importRowProgress: {
      updateMany: async (args) => {
        progressUpdates.push(args);
        return { count: 1 };
      },
    },
    importBatch: {
      update: async (args) => {
        batchUpdates.push(args);
      },
    },
    importChangeLog: {
      findMany: async () => {
        throw new Error('Row completion must not reread change logs.');
      },
    },
  };
  const changes = [{
    importBatchId: 'batch-1',
    rowProgressId: 'row-1',
    entityId: 'vehicle-1',
    entityType: 'Vehicle',
    operation: 'UPDATE',
    before: { registrationNumber: null, updatedAt: '2026-01-01T00:00:00.000Z' },
    after: { registrationNumber: 'ABC123', updatedAt: '2026-01-01T00:00:01.000Z' },
  }];

  await completeImportRow(transaction, 'batch-1', 2, 'row-1', 'skipped', changes);

  assert.equal(progressUpdates.length, 1);
  assert.equal(progressUpdates[0].data.loggedChangeCount, 1);
  assert.equal(progressUpdates[0].data.outcome, 'skipped');
  assert.equal(batchUpdates.length, 1);
});

test('does not complete a mutation outcome without complete evidence', async () => {
  let progressUpdateCount = 0;
  const transaction = {
    importRowProgress: {
      updateMany: async () => {
        progressUpdateCount += 1;
        return { count: 1 };
      },
    },
    importBatch: { update: async () => {} },
  };

  await assert.rejects(
    completeImportRow(transaction, 'batch-1', 2, 'row-1', 'created'),
    /complete mutation evidence/,
  );
  assert.equal(progressUpdateCount, 0);
});
