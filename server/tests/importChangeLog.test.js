import test from 'node:test';
import assert from 'node:assert/strict';
import { importSnapshot, recordImportChange } from '../src/utils/importChangeLog.js';
import { importChangeLogIsComplete } from '../src/utils/importBatchStats.js';

function createTransaction() {
  const changes = [];
  return {
    changes,
    importChangeLog: {
      create: async ({ data }) => {
        changes.push(data);
        return data;
      },
    },
  };
}

const rowChange = {
  importBatchId: 'batch-1',
  rowProgressId: 'progress-1',
  sequence: 1,
  entityType: 'Vehicle',
  entityId: 'vehicle-1',
  operation: 'UPDATE',
  before: { model: 'i20', updatedAt: '2025-01-01T00:00:00.000Z' },
  after: { model: 'i20 N', updatedAt: '2025-01-02T00:00:00.000Z' },
};

test('recordImportChange writes complete field-level mutation evidence', async () => {
  const transaction = createTransaction();

  await recordImportChange(transaction, rowChange);

  assert.deepEqual(transaction.changes, [{
    ...rowChange,
    evidenceScope: 'row',
    ccmId: null,
  }]);
});

test('recordImportChange rejects missing identity, invalid sequence, and mismatched update fields', async () => {
  const transaction = createTransaction();
  const invalidChanges = [
    { ...rowChange, importBatchId: '' },
    { ...rowChange, sequence: 0 },
    { ...rowChange, sequence: 1.5 },
    { ...rowChange, after: { model: 'i20 N' } },
    { ...rowChange, before: { model: undefined }, after: { model: 'i20 N' } },
    { ...rowChange, operation: 'DELETE' },
  ];

  for (const change of invalidChanges) {
    await assert.rejects(recordImportChange(transaction, change), TypeError);
  }
  assert.equal(transaction.changes.length, 0);
});

test('recordImportChange requires creates to have an empty before snapshot and matching entity identity', async () => {
  const transaction = createTransaction();
  const create = {
    ...rowChange,
    operation: 'CREATE',
    before: {},
    after: { id: 'vehicle-1', model: 'i20' },
  };

  await recordImportChange(transaction, create);
  await assert.rejects(recordImportChange(transaction, {
    ...create,
    sequence: 2,
    after: { id: 'different-vehicle', model: 'i20' },
  }), TypeError);
  await assert.rejects(recordImportChange(transaction, {
    ...create,
    sequence: 2,
    before: { model: 'old' },
  }), TypeError);

  assert.equal(transaction.changes.length, 1);
});

test('importSnapshot preserves nulls and normalizes dates and nested JSON values', () => {
  const normalized = importSnapshot({
    explicitNull: null,
    timestamp: new Date('2025-01-02T03:04:05.000Z'),
    nested: {
      values: [null, { enabled: true, labels: ['one', 'two'] }],
    },
  });

  assert.deepEqual(normalized, {
    explicitNull: null,
    timestamp: '2025-01-02T03:04:05.000Z',
    nested: {
      values: [null, { enabled: true, labels: ['one', 'two'] }],
    },
  });
  assert.equal(Object.hasOwn(normalized, 'explicitNull'), true);
});

test('importSnapshot omits undefined object properties but preserves null as a distinct field', () => {
  const normalized = importSnapshot({
    omitted: undefined,
    explicitNull: null,
  });

  assert.deepEqual(normalized, { explicitNull: null });
  assert.equal(Object.hasOwn(normalized, 'omitted'), false);
  assert.equal(Object.hasOwn(normalized, 'explicitNull'), true);
});

test('recordImportChange validates the JSON-normalized snapshots it persists', async () => {
  const transaction = createTransaction();
  const before = {
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    totalLaborCost: null,
    importedDetails: {
      explicitNull: null,
      nested: { tags: ['old', null] },
    },
    omitted: undefined,
  };
  const after = {
    updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    totalLaborCost: 125,
    importedDetails: {
      explicitNull: null,
      nested: { tags: ['new', null] },
    },
    omitted: undefined,
  };

  await recordImportChange(transaction, {
    ...rowChange,
    entityType: 'WorkshopVisit',
    before,
    after,
  });

  const [stored] = transaction.changes;
  assert.deepEqual(stored.before, {
    updatedAt: '2025-01-01T00:00:00.000Z',
    totalLaborCost: null,
    importedDetails: {
      explicitNull: null,
      nested: { tags: ['old', null] },
    },
  });
  assert.deepEqual(stored.after, {
    updatedAt: '2025-01-02T00:00:00.000Z',
    totalLaborCost: 125,
    importedDetails: {
      explicitNull: null,
      nested: { tags: ['new', null] },
    },
  });
  assert.equal(Object.hasOwn(stored.before, 'omitted'), false);
  assert.equal(importChangeLogIsComplete(stored), true);
});

test('recordImportChange rejects normalized UPDATE snapshots when a null field is omitted', async () => {
  const transaction = createTransaction();

  await assert.rejects(recordImportChange(transaction, {
    ...rowChange,
    entityType: 'WorkshopVisit',
    before: {
      totalLaborCost: null,
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    },
    after: {
      totalLaborCost: undefined,
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    },
  }), TypeError);
  assert.equal(transaction.changes.length, 0);
});

test('recordImportChange rejects no-op and timestamp-only UPDATE snapshots', async () => {
  const transaction = createTransaction();
  const unchanged = {
    ...rowChange,
    before: {
      model: 'i20',
      importedDetails: { labels: ['one', 'two'], enabled: true },
      saleDate: null,
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    },
    after: {
      model: 'i20',
      importedDetails: { enabled: true, labels: ['one', 'two'] },
      saleDate: null,
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    },
  };

  await assert.rejects(recordImportChange(transaction, unchanged), /at least one changed business field/);
  await assert.rejects(recordImportChange(transaction, {
    ...rowChange,
    before: { model: 'i20', updatedAt: '2025-01-01T00:00:00.000Z' },
    after: { model: 'i20', updatedAt: '2025-01-02T00:00:00.000Z' },
  }), /at least one changed business field/);
  assert.equal(transaction.changes.length, 0);
});

test('recordImportChange accepts real field changes and null transitions', async () => {
  const transaction = createTransaction();
  const changes = [
    { ...rowChange, before: { model: 'i20' }, after: { model: 'i20 N' } },
    { ...rowChange, before: { saleDate: null }, after: { saleDate: '2025-01-01' } },
    { ...rowChange, before: { saleDate: '2025-01-01' }, after: { saleDate: null } },
    {
      ...rowChange,
      before: { importedDetails: { labels: ['one', 'two'] } },
      after: { importedDetails: { labels: ['two', 'one'] } },
    },
  ];

  for (const [index, change] of changes.entries()) {
    await recordImportChange(transaction, { ...change, sequence: index + 1 });
  }

  assert.equal(transaction.changes.length, changes.length);
});
