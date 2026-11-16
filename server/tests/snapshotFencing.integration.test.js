import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('snapshot claim fencing prevents obsolete publication and preserves last-good metrics', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const { markCreSnapshotsDirty } = await import('../src/utils/performanceSnapshotState.js');
  const id = randomUUID();
  const key = { creId: `${id}-cre`, ccmId: `${id}-ccm`, year: 2026, month: 11, viewer: 'CRE' };
  const now = new Date('2026-11-14T06:00:00Z');
  const metrics = (callsThisMonth) => ({ callsThisMonth, details: {}, asOf: now });
  const where = { creId_ccmId_year_month_viewer: key };
  const read = () => prisma.crePerformanceSnapshot.findUniqueOrThrow({ where });
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.create({ data: { id: key.creId, ccmId: key.ccmId, name: 'Test CRE', password: 'test', role: 'CRE' } });
    assert.equal((await refreshSnapshot(key, { now, compute: async () => metrics(7) })).refreshed, true);

    for (const behavior of ['success', 'failure']) {
      const entered = deferred();
      const release = deferred();
      const old = refreshSnapshot(key, { now, compute: async () => {
        entered.resolve();
        await release.promise;
        if (behavior === 'failure') throw new Error('obsolete failure');
        return metrics(10);
      } });
      await entered.promise;
      const newer = await refreshSnapshot(key, { now: new Date(now.getTime() + 11 * 60000), compute: async () => metrics(20) });
      assert.equal(newer.refreshed, true);
      release.resolve();
      assert.deepEqual(await old, { refreshed: false, reason: 'superseded' });
      const row = await read();
      assert.equal(row.status, 'ok');
      assert.equal(row.callsThisMonth, 20);
      assert.equal(row.failureCount, 0);
      assert.equal(row.claimToken, null);
    }

    const dirty = await refreshSnapshot(key, { now, compute: async () => {
      await markCreSnapshotsDirty(prisma, { creIds: [key.creId], now });
      return metrics(99);
    } });
    assert.deepEqual(dirty, { refreshed: false, reason: 'dirty' });
    assert.equal((await read()).callsThisMonth, 20);
    assert.equal((await read()).status, 'dirty');

    const changed = await refreshSnapshot(key, { now, compute: async () => {
      await prisma.performanceSnapshotRevision.update({
        where: { scope: `ccm:${key.ccmId}` }, data: { revision: { increment: 1 } },
      });
      return metrics(101);
    } });
    assert.deepEqual(changed, { refreshed: false, reason: 'dirty' });
    assert.equal((await read()).callsThisMonth, 20);
    assert.equal((await read()).status, 'dirty');
  } finally {
    await prisma.crePerformanceSnapshot.deleteMany({ where: { creId: key.creId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${key.ccmId}` } });
    await prisma.user.deleteMany({ where: { id: key.creId } });
    await prisma.$disconnect();
  }
});
