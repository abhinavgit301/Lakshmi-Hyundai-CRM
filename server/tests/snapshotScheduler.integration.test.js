import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('requested snapshots are persisted and processed by the bounded scheduler', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { requestSnapshotRefresh, refreshDueSnapshots } = await import('../src/services/performanceSnapshotService.js');
  const ccmId = `${randomUUID()}-requested`;
  const now = new Date('2026-11-14T06:00:00Z');
  const keys = Array.from({ length: 5 }, (_, i) => ({
    creId: `${ccmId}-${i}`, ccmId, year: 2026, month: 11, viewer: 'CRE',
  }));
  const scopedDb = {
    user: { findMany: async () => [] },
    crePerformanceSnapshot: {
      findMany: (args) => prisma.crePerformanceSnapshot.findMany({
        ...args, where: { AND: [args.where, { ccmId }] },
      }),
    },
  };
  try {
    await Promise.all([...keys, keys[0]].map((key) => requestSnapshotRefresh(key, { db: prisma, signal: () => {} })));
    assert.equal(await prisma.crePerformanceSnapshot.count({ where: { ccmId, status: 'pending' } }), 5);
    let active = 0;
    let maximum = 0;
    const processed = new Set();
    const result = await refreshDueSnapshots({
      now, db: scopedDb,
      refresh: async (row) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        processed.add(row.creId);
        active -= 1;
        return { refreshed: true };
      },
    });
    assert.deepEqual(result, { due: 5, refreshed: 5 });
    assert.equal(maximum, 2);
    assert.equal(processed.size, 5);
  } finally {
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId } });
    await prisma.$disconnect();
  }
});

test('scheduler skips failed rows in backoff before applying its database limit', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { findSnapshotsDueForRefresh } = await import('../src/services/performanceSnapshotService.js');
  const id = randomUUID();
  const ccmId = `${id}-team`;
  const now = new Date('2026-11-14T06:00:00Z');
  const key = { ccmId, year: 2026, month: 11, viewer: 'CRE' };
  const db = {
    crePerformanceSnapshot: {
      findMany: (args) => prisma.crePerformanceSnapshot.findMany({
        ...args,
        where: { AND: [args.where, { ccmId }] },
      }),
    },
  };
  try {
    await prisma.crePerformanceSnapshot.createMany({ data: [
      ...Array.from({ length: 70 }, (_, i) => ({
        ...key, creId: `${id}-failed-${i}`, status: 'failed', failureCount: 1, lastAttemptAt: now,
      })),
      { ...key, creId: `${id}-pending`, status: 'pending' },
    ] });
    const pending = await findSnapshotsDueForRefresh({ now, limit: 1, db });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].creId, `${id}-pending`);
    const before = await findSnapshotsDueForRefresh({ now: new Date(now.getTime() + 59999), limit: 100, db });
    assert.deepEqual(before.map(({ creId }) => creId), [`${id}-pending`]);
    const after = await findSnapshotsDueForRefresh({ now: new Date(now.getTime() + 60000), limit: 100, db });
    assert.equal(after.filter(({ status }) => status === 'failed').length, 70);
    assert.equal(after.filter(({ status }) => status === 'pending').length, 1);
    const limited = await findSnapshotsDueForRefresh({ now: new Date(now.getTime() + 60000), limit: 1, db });
    assert.equal(limited[0].creId, `${id}-pending`, 'eligible failures must not hide unattempted work');

    await prisma.crePerformanceSnapshot.updateMany({
      where: { ccmId, status: 'pending' },
      data: { status: 'dirty', lastAttemptAt: new Date(now.getTime() - 600000) },
    });
    const waiting = await findSnapshotsDueForRefresh({ now: new Date(now.getTime() + 60000), limit: 1, db });
    assert.equal(waiting[0].creId, `${id}-pending`, 'older dirty work must not be starved by retries');
    await prisma.crePerformanceSnapshot.updateMany({
      where: { ccmId, creId: `${id}-pending` },
      data: { lastAttemptAt: new Date(now.getTime() + 60000) },
    });
    const next = await findSnapshotsDueForRefresh({ now: new Date(now.getTime() + 60000), limit: 1, db });
    assert.equal(next[0].status, 'failed', 'eligible retries must also progress');
  } finally {
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId } });
    await prisma.$disconnect();
  }
});
