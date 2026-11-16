import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;
const refreshPath = fileURLToPath(new URL('../test-support/snapshotWorker.mjs', import.meta.url));
const writePath = fileURLToPath(new URL('../test-support/snapshotMixedWriteWorker.mjs', import.meta.url));

test('shared workshop history fences independent refreshes across CCMs at commit', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { workshopVisitVisibilityWhere } = await import('../src/utils/creAccess.js');
  const id = randomUUID();
  const vin = `1HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const now = new Date('2026-11-14T06:00:00Z');
  const teams = [`${id}-team-a`, `${id}-team-b`];
  const creIds = [`${id}-cre-a`, `${id}-cre-b`];
  const manager = `${id}-manager`;
  const keys = teams.map((ccmId, index) => ({ creId: creIds[index], ccmId, year: 2026, month: 11, viewer: 'CRE' }));
  const workers = new Set();
  const start = (path, env) => {
    const child = fork(path, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env, DATABASE_URL: databaseUrl, PERFORMANCE_AGGREGATES_MAINTAIN: 'true',
        PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED: 'true', SERVICE_CONTACT_STATUS_ENABLED: 'false', ...env,
      },
    });
    workers.add(child);
    child.once('exit', () => workers.delete(child));
    return child;
  };
  const message = async (child, type) => {
    const [event] = await once(child, 'message');
    assert.equal(event.type, type, event.message);
    return event;
  };
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.createMany({ data: [
      { id: manager, ccmId: teams[0], name: 'CCM', role: 'CCM', password: 'test' },
      ...creIds.map((creId, index) => ({ id: creId, ccmId: teams[index], name: 'CRE', role: 'CRE', password: 'test' })),
    ] });
    const physical = await prisma.physicalVehicle.create({ data: { vin } });
    for (const [index, ccmId] of teams.entries()) {
      const customer = await prisma.customer.create({ data: {
        customerCode: `${id}-${index}`, fullName: 'Customer', mobileNumber: '9000000000', ccmId,
      } });
      const vehicle = await prisma.vehicle.create({ data: { vin, ccmId, customerId: customer.id, physicalVehicleId: physical.id } });
      await prisma.masterCallList.create({ data: {
        vin, ccmId, vehicleId: vehicle.id, ownerUserId: creIds[index], customerName: 'Customer', mobileNumber: '9000000000',
      } });
    }
    await prisma.crePerformanceSnapshot.createMany({ data: keys.map((key, index) => ({
      ...key, status: 'ok', callsThisMonth: 7 + index, computedAt: now,
    })) });
    const revision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision;
    const refreshes = keys.map((key, index) => start(refreshPath, {
      SNAPSHOT_WORKER_CASE: JSON.stringify({ key, now, calls: 99 + index }),
    }));
    await Promise.all(refreshes.map((worker) => message(worker, 'ready')));
    const writer = start(writePath, {
      SNAPSHOT_WRITE_CASE: JSON.stringify({
        kind: 'manual', hold: true, ccmId: teams[0], ccmUserId: manager, vin, roNumber: `${id}-ro`,
      }),
    });
    await message(writer, 'ready');
    const writeReady = message(writer, 'before-flush');
    writer.send({ action: 'start' });
    await writeReady;
    assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id } }), 0);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, revision);
    for (const key of keys) {
      const row = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
      assert.equal(row.status, 'refreshing');
      assert.equal(row.dirtyVersion, 0n);
    }
    const writeResult = message(writer, 'result');
    writer.send({ action: 'release' });
    assert.equal((await writeResult).status, 201);
    assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id } }), 1);
    for (const [index, ccmId] of teams.entries()) {
      assert.equal(await prisma.workshopVisit.count({
        where: { physicalVehicleId: physical.id, ...workshopVisitVisibilityWhere({ role: 'CRE', id: creIds[index], ccmId }) },
      }), 1);
    }
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, revision + 1n);
    const refreshResults = refreshes.map((worker) => message(worker, 'result'));
    for (const worker of refreshes) worker.send({ action: 'success' });
    for (const result of await Promise.all(refreshResults)) {
      assert.deepEqual(result.result, { refreshed: false, reason: 'dirty' });
    }
    for (const [index, key] of keys.entries()) {
      const row = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
      assert.equal(row.status, 'dirty');
      assert.equal(row.dirtyVersion, 1n);
      assert.equal(row.callsThisMonth, 7 + index);
    }
  } finally {
    for (const child of workers) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await prisma.auditLog.deleteMany({ where: { userId: manager } });
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.creCallDaily.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.masterCallList.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.workshopVisit.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.vehicle.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.customer.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.physicalVehicle.deleteMany({ where: { vin } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId: { in: teams } } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: { in: teams.map((ccmId) => `ccm:${ccmId}`) } } });
    await prisma.user.deleteMany({ where: { id: { in: [manager, ...creIds] } } });
    await prisma.$disconnect();
  }
});
