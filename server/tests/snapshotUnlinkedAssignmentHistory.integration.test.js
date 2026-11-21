import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('unlinked assignments are unassigned and audited atomically', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { unassignCreAssignments } = await import('../src/utils/customerAllocation.js');
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  const creId = `${id}-cre`;
  const entryId = `${id}-entry`;
  const input = { ccmId, departingCreId: creId, actorId: null };
  try {
    await prisma.user.create({ data: { id: creId, name: 'Test CRE', password: 'test', role: 'CRE', ccmId } });
    await prisma.masterCallList.create({ data: {
      id: entryId, customerName: 'Test', mobileNumber: '000', vin: id, ccmId, ownerUserId: creId,
    } });
    const failure = new Error('injected failure');
    await assert.rejects(prisma.$transaction(async (tx) => {
      await unassignCreAssignments(tx, input);
      throw failure;
    }), (error) => error === failure);
    assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entryId } })).ownerUserId, creId);
    assert.equal(await prisma.creAssignmentHistory.count({ where: { masterCallListId: entryId } }), 0);

    await prisma.$transaction((tx) => unassignCreAssignments(tx, input));
    const entry = await prisma.masterCallList.findUniqueOrThrow({ where: { id: entryId } });
    assert.equal(entry.ownerUserId, null);
    assert.equal(entry.assignmentNeedsReview, true);
    const events = await prisma.creAssignmentHistory.findMany({ where: { masterCallListId: entryId } });
    assert.equal(events.length, 1);
    assert.equal(events[0].vehicleId, null);
    assert.equal(events[0].previousCreId, creId);
    assert.equal(events[0].newCreId, null);
  } finally {
    await prisma.creAssignmentHistory.deleteMany({ where: { masterCallListId: entryId } });
    await prisma.auditLog.deleteMany({ where: { entityId: creId } });
    await prisma.masterCallList.deleteMany({ where: { id: entryId } });
    await prisma.user.deleteMany({ where: { id: creId } });
    await prisma.$disconnect();
  }
});
