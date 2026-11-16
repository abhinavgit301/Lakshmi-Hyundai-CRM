import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('source invalidation waits until aggregate locks are acquired', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { invalidateSnapshotSourceWrite } = await import('../src/utils/performanceSnapshotState.js');
  const { lockCreAggregates, noteCreOwnershipChange } = await import('../src/utils/creCallAggregates.js');
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  const creId = `${id}-cre`;
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const revisionHeld = deferred();
  const aggregateHeld = deferred();
  const proceed = deferred();
  let first;
  let second;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    first = prisma.$transaction(async (tx) => {
      await invalidateSnapshotSourceWrite(tx, { ccmIds: [ccmId] });
      revisionHeld.resolve();
      await proceed.promise;
      noteCreOwnershipChange(tx, { ccmId, creIds: [creId] });
    }, { timeout: 15000 });
    await revisionHeld.promise;
    second = prisma.$transaction(async (tx) => {
      await lockCreAggregates(tx, creId);
      aggregateHeld.resolve();
      await proceed.promise;
      await invalidateSnapshotSourceWrite(tx, { ccmIds: [ccmId] });
    }, { timeout: 15000 });
    await aggregateHeld.promise;
    proceed.resolve();
    const results = await Promise.allSettled([first, second]);
    first = null;
    second = null;
    assert.deepEqual(results.map(({ status }) => status), ['fulfilled', 'fulfilled']);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${ccmId}` } })).revision, 2n);
  } finally {
    proceed.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await prisma.creCallDaily.deleteMany({ where: { userId: creId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${ccmId}` } });
    await prisma.$disconnect();
  }
});
