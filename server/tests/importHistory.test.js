import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignImportTargetCcm,
  getImportHistory,
  importBatchAttribution,
  resolveImportTargetCcm,
} from '../src/controllers/importController.js';
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

  test('CCM import ownership is resolved from the authenticated user and rejects other targets', async () => {
    const database = { user: { findFirst: async () => ({ ccmId: 'ccm-a' }) } };
    assert.deepEqual(await resolveImportTargetCcm(
      { id: 'ccm-user-a', role: 'CCM', ccmId: 'ccm-a' },
      ['ccm-a'],
      database,
    ), { ccmId: 'ccm-a' });
    assert.match((await resolveImportTargetCcm(
      { id: 'ccm-user-a', role: 'CCM', ccmId: 'ccm-a' },
      ['ccm-b'],
      database,
    )).error, /authenticated CCM/i);
    assert.match((await resolveImportTargetCcm(
      { id: 'ccm-user-a', role: 'CCM', ccmId: null },
      [],
      database,
    )).error, /active CCM assignment/i);
  });

  test('Admin and GM imports require an active selected CCM target', async () => {
    const database = { user: { findFirst: async ({ where }) => (where.ccmId === 'ccm-b' ? { ccmId: 'ccm-b' } : null) } };
    for (const role of ['ADMIN', 'GM']) {
      assert.deepEqual(await resolveImportTargetCcm({ id: 'manager', role }, ['ccm-b'], database), { ccmId: 'ccm-b' });
      assert.match((await resolveImportTargetCcm({ id: 'manager', role }, [], database)).error, /select a target CCM/i);
      assert.match((await resolveImportTargetCcm({ id: 'manager', role }, ['missing'], database)).error, /invalid/i);
    }
  });

  test('CSV-level CCM ownership is replaced by the validated selected target', () => {
    assert.deepEqual(assignImportTargetCcm({ vin: 'VIN-1', ccmId: 'ccm-b' }, 'ccm-a'), {
      vin: 'VIN-1',
      ccmId: 'ccm-a',
    });
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

test('import history returns the latest 20 batches and a cursor when more exist', async () => {
  const batches = Array.from({ length: 21 }, (_, index) => ({
    ...historyBatch({ id: `batch-${index + 1}`, ccmId: 'ccm-a', importedByUserId: null }),
    createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, index)),
  }));
  let query;
  await withImportHistoryMocks({ batches: [], users: [] }, async () => {
    prisma.importBatch.findMany = async (args) => {
      query = args;
      return batches;
    };
    const res = mockRes();

    await getImportHistory({ user: { id: 'admin-a', role: 'ADMIN' }, query: {} }, res);

    assert.equal(query.take, 21);
    assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.deepEqual(res.body.imports.map(({ id }) => id), batches.slice(0, 20).map(({ id }) => id));
    assert.equal(res.body.hasMore, true);
    assert.deepEqual(JSON.parse(Buffer.from(res.body.nextCursor, 'base64url').toString('utf8')), {
      id: 'batch-20',
      createdAt: batches[19].createdAt.toISOString(),
    });
  });
});

test('import history cursor applies a stable keyset boundary and rejects malformed cursors', async () => {
  const anchorDate = new Date('2026-10-30T06:00:00.000Z');
  let query;
  const originalFindMany = prisma.importBatch.findMany;
  prisma.importBatch.findMany = async (args) => {
    query = args;
    return [];
  };
  try {
    const cursor = Buffer.from(JSON.stringify({
      id: 'batch-anchor',
      createdAt: anchorDate.toISOString(),
    })).toString('base64url');
    const res = mockRes();

    await getImportHistory({ user: { id: 'admin-a', role: 'ADMIN' }, query: { ccmId: 'ccm-a', cursor } }, res);

    assert.deepEqual(query.where, {
      ccmId: 'ccm-a',
      OR: [
        { createdAt: { lt: anchorDate } },
        { createdAt: anchorDate, id: { lt: 'batch-anchor' } },
      ],
    });
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextCursor, null);

    const invalid = mockRes();
    await getImportHistory({ user: { id: 'admin-a', role: 'ADMIN' }, query: { cursor: 'not-a-cursor' } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body.message, /cursor is invalid/i);
  } finally {
    prisma.importBatch.findMany = originalFindMany;
  }
});
