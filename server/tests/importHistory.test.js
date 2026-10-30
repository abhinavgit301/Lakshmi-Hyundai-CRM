import test from 'node:test';
import assert from 'node:assert/strict';
import { getImportHistory, importBatchAttribution } from '../src/controllers/importController.js';
import { prisma } from '../src/config/prisma.js';

function mockRes() {
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

async function withImportHistoryMocks({ batches, users }, run) {
  const originals = {
    importFindMany: prisma.importBatch.findMany,
    userFindMany: prisma.user.findMany,
    changeFindMany: prisma.importChangeLog.findMany,
    changeGroupBy: prisma.importChangeLog.groupBy,
    progressGroupBy: prisma.importRowProgress.groupBy,
  };
  prisma.importBatch.findMany = async () => batches;
  prisma.user.findMany = async () => users;
  prisma.importChangeLog.findMany = async () => [];
  prisma.importChangeLog.groupBy = async () => [];
  prisma.importRowProgress.groupBy = async () => [];
  try {
    await run();
  } finally {
    prisma.importBatch.findMany = originals.importFindMany;
    prisma.user.findMany = originals.userFindMany;
    prisma.importChangeLog.findMany = originals.changeFindMany;
    prisma.importChangeLog.groupBy = originals.changeGroupBy;
    prisma.importRowProgress.groupBy = originals.progressGroupBy;
  }
}

function historyBatch({ id, ccmId, importedByUserId }) {
  return {
    id,
    fileName: `${id}.csv`,
    ccmId,
    importedByUserId,
    createdAt: new Date('2026-10-30T06:00:00Z'),
    status: 'completed',
    totalRows: 1,
    rowErrors: [],
    processingStartedAt: null,
  };
}

test('import batches keep the importer separate from the selected CCM owner', () => {
  assert.deepEqual(importBatchAttribution(
    { id: 'ccm-user-a', role: 'CCM', ccmId: 'ccm-a' },
    'ccm-b',
  ), {
    importedByUserId: 'ccm-user-a',
    ccmId: 'ccm-a',
  });
  assert.deepEqual(importBatchAttribution(
    { id: 'admin-a', role: 'ADMIN', ccmId: null },
    'ccm-b',
  ), {
    importedByUserId: 'admin-a',
    ccmId: 'ccm-b',
  });
});

test('Admin import history applies the selected CCM filter and preserves the actual importer', async () => {
  const batch = historyBatch({ id: 'batch-a', ccmId: 'ccm-a', importedByUserId: 'admin-a' });
  let where;
  await withImportHistoryMocks({
    batches: [batch],
    users: [{ id: 'admin-a', name: 'Admin A', role: 'ADMIN' }],
  }, async () => {
    const originalFindMany = prisma.importBatch.findMany;
    prisma.importBatch.findMany = async (args) => {
      where = args.where;
      return [batch];
    };
    try {
      const res = mockRes();
      await getImportHistory({ user: { id: 'admin-b', role: 'ADMIN' }, query: { ccmId: 'ccm-a' } }, res);
      assert.deepEqual(where, { ccmId: 'ccm-a' });
      assert.equal(res.body.imports.length, 1);
      assert.deepEqual(res.body.imports[0].importedBy, { id: 'admin-a', name: 'Admin A', role: 'ADMIN' });
      assert.equal(res.body.imports[0].ccmId, 'ccm-a');
    } finally {
      prisma.importBatch.findMany = originalFindMany;
    }
  });
});

test('Admin import history without a CCM filter returns imports across CCMs', async () => {
  const batches = [
    historyBatch({ id: 'batch-a', ccmId: 'ccm-a', importedByUserId: 'admin-a' }),
    historyBatch({ id: 'batch-b', ccmId: 'ccm-b', importedByUserId: 'ccm-b-user' }),
  ];
  let where;
  await withImportHistoryMocks({
    batches,
    users: [
      { id: 'admin-a', name: 'Admin A', role: 'ADMIN' },
      { id: 'ccm-b-user', name: 'CCM B', role: 'CCM' },
    ],
  }, async () => {
    const originalFindMany = prisma.importBatch.findMany;
    prisma.importBatch.findMany = async (args) => {
      where = args.where;
      return batches;
    };
    try {
      const res = mockRes();
      await getImportHistory({ user: { id: 'admin-b', role: 'ADMIN' }, query: {} }, res);
      assert.deepEqual(where, {});
      assert.deepEqual(res.body.imports.map(({ ccmId }) => ccmId), ['ccm-a', 'ccm-b']);
      assert.equal(res.body.imports[1].importedBy.name, 'CCM B');
    } finally {
      prisma.importBatch.findMany = originalFindMany;
    }
  });
});

test('Admin can select a different CCM without mixing its batches with another team', async () => {
  const batch = historyBatch({ id: 'batch-b', ccmId: 'ccm-b', importedByUserId: 'ccm-b-user' });
  let where;
  await withImportHistoryMocks({
    batches: [batch],
    users: [{ id: 'ccm-b-user', name: 'CCM B', role: 'CCM' }],
  }, async () => {
    const originalFindMany = prisma.importBatch.findMany;
    prisma.importBatch.findMany = async (args) => {
      where = args.where;
      return [batch];
    };
    try {
      const res = mockRes();
      await getImportHistory({ user: { id: 'admin-a', role: 'ADMIN' }, query: { ccmId: 'ccm-b' } }, res);
      assert.deepEqual(where, { ccmId: 'ccm-b' });
      assert.deepEqual(res.body.imports.map(({ id }) => id), ['batch-b']);
    } finally {
      prisma.importBatch.findMany = originalFindMany;
    }
  });
});

test('CCM import history stays scoped to the signed-in importer even if a CCM filter is supplied', async () => {
  let where;
  await withImportHistoryMocks({ batches: [], users: [] }, async () => {
    const originalFindMany = prisma.importBatch.findMany;
    prisma.importBatch.findMany = async (args) => {
      where = args.where;
      return [];
    };
    try {
      const res = mockRes();
      await getImportHistory({ user: { id: 'ccm-a-user', role: 'CCM' }, query: { ccmId: 'ccm-b' } }, res);
      assert.deepEqual(where, { importedByUserId: 'ccm-a-user' });
      assert.deepEqual(res.body.imports, []);
    } finally {
      prisma.importBatch.findMany = originalFindMany;
    }
  });
});

test('Admin import history rejects an oversized CCM filter', async () => {
  const originalFindMany = prisma.importBatch.findMany;
  prisma.importBatch.findMany = async () => {
    throw new Error('history query should not run');
  };
  try {
    const res = mockRes();
    await getImportHistory({ user: { id: 'admin-a', role: 'ADMIN' }, query: { ccmId: 'c'.repeat(256) } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /255 characters/);
  } finally {
    prisma.importBatch.findMany = originalFindMany;
  }
});
