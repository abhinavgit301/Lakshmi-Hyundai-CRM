import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;
const workerPath = fileURLToPath(new URL('../test-support/snapshotWriteWorker.mjs', import.meta.url));
const mixedWorkerPath = fileURLToPath(new URL('../test-support/snapshotMixedWriteWorker.mjs', import.meta.url));

test('independent application writes serialize on a snapshot revision without losing invalidations', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  const userId = `${id}-user`;
  const customerId = `${id}-customer`;
  const key = { creId: `${id}-cre`, ccmId, year: 2026, month: 11, viewer: 'CRE' };
  const scope = `ccm:${ccmId}`;
  const workers = new Set();
  const start = (holdRevision) => {
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PERFORMANCE_AGGREGATES_MAINTAIN: 'true',
        SERVICE_CONTACT_STATUS_ENABLED: 'false',
        SNAPSHOT_WRITE_CASE: JSON.stringify({ ccmId, userId, customerId, holdRevision }),
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
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }, { scope }], skipDuplicates: true });
    await prisma.user.create({ data: { id: userId, ccmId, name: 'Test CCM', role: 'CCM', password: 'test' } });
    await prisma.customer.create({ data: { id: customerId, ccmId, customerCode: id, fullName: 'Test customer' } });
    await prisma.crePerformanceSnapshot.create({ data: { ...key, status: 'ok', callsThisMonth: 7, computedAt: new Date() } });
    const initial = await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope } });

    const first = start(true);
    await message(first, 'ready');
    const holding = message(first, 'holding');
    first.send({ action: 'start' });
    const holder = await holding;
    const second = start(false);
    await message(second, 'ready');
    const flushing = message(second, 'flushing');
    second.send({ action: 'start' });
    const blocked = await flushing;
    assert.notEqual(blocked.pid, holder.pid);
    let isBlocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [{ blockers }] = await prisma.$queryRaw`SELECT pg_blocking_pids(${blocked.pid}) AS blockers`;
      if (blockers.includes(holder.pid)) { isBlocked = true; break; }
      await delay(20);
    }
    assert.ok(isBlocked, 'second process must wait for the first process revision lock');
    assert.equal(await prisma.followUp.count({ where: { customerId } }), 0);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope } })).revision, initial.revision);
    const beforeCommit = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(beforeCommit.status, 'ok');
    assert.equal(beforeCommit.dirtyVersion, 0n);
    const firstResult = message(first, 'result');
    const secondResult = message(second, 'result');
    first.send({ action: 'release' });
    assert.equal((await firstResult).status, 201);
    assert.equal((await secondResult).status, 201);
    assert.equal(await prisma.followUp.count({ where: { customerId } }), 2);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope } })).revision, initial.revision + 2n);
    const snapshot = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(snapshot.status, 'dirty');
    assert.equal(snapshot.dirtyVersion, 2n);
    assert.equal(snapshot.callsThisMonth, 7);
  } finally {
    for (const child of workers) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await prisma.followUp.deleteMany({ where: { customerId } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }
});

test('call creation and ownership reassignment serialize aggregate rebuilds across processes', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { auditCreCallAggregates } = await import('../src/utils/creCallAggregateAudit.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  const creId = `${id}-cre`;
  const nextCreId = `${id}-next`;
  const ccmUserId = `${id}-manager`;
  const customerId = `${id}-customer`;
  const vehicleId = `${id}-vehicle`;
  const entryId = `${id}-entry`;
  const vin = `1HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const key = { creId, ccmId, year: 2026, month: 11, viewer: 'CRE' };
  const scope = `ccm:${ccmId}`;
  const workers = new Set();
  let releaseRefresh;
  let refresh;
  const start = (kind, { hold = false, caller = creId, assignee = nextCreId } = {}) => {
    const child = fork(mixedWorkerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env, DATABASE_URL: databaseUrl, PERFORMANCE_AGGREGATES_MAINTAIN: 'true',
        SERVICE_CONTACT_STATUS_ENABLED: 'false',
        SNAPSHOT_WRITE_CASE: JSON.stringify({
          kind, hold, ccmId, creId: caller, nextCreId: assignee, ccmUserId, customerId, vehicleId, entryId,
        }),
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
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }, { scope }], skipDuplicates: true });
    await prisma.user.createMany({ data: [
      { id: ccmUserId, ccmId, name: 'CCM', role: 'CCM', password: 'test' },
      { id: creId, ccmId, name: 'CRE', role: 'CRE', password: 'test' },
      { id: nextCreId, ccmId, name: 'Next CRE', role: 'CRE', password: 'test' },
    ] });
    await prisma.customer.create({ data: { id: customerId, ccmId, customerCode: id, fullName: 'Customer' } });
    const physical = await prisma.physicalVehicle.create({ data: { vin } });
    await prisma.vehicle.create({ data: { id: vehicleId, ccmId, vin, customerId, physicalVehicleId: physical.id } });
    await prisma.masterCallList.create({ data: {
      id: entryId, ccmId, vin, vehicleId, ownerUserId: creId, customerName: 'Customer', mobileNumber: '9000000000',
    } });
    await prisma.crePerformanceSnapshot.create({ data: { ...key, status: 'ok', callsThisMonth: 7, computedAt: new Date() } });
    const initial = await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope } });
    let refreshStarted;
    const ready = new Promise((resolve) => { refreshStarted = resolve; });
    const gate = new Promise((resolve) => { releaseRefresh = resolve; });
    refresh = refreshSnapshot(key, { compute: async () => {
      refreshStarted();
      await gate;
      return { callsThisMonth: 99, details: {}, asOf: new Date() };
    } });
    await ready;
    const first = start('call', { hold: true });
    await message(first, 'ready');
    const callHolding = message(first, 'before-flush');
    first.send({ action: 'start' });
    const holder = await callHolding;
    const second = start('assignment');
    await message(second, 'ready');
    const assignmentFlushing = message(second, 'before-flush');
    second.send({ action: 'start' });
    const blocked = await assignmentFlushing;
    let isBlocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [{ blockers }] = await prisma.$queryRaw`SELECT pg_blocking_pids(${blocked.pid}) AS blockers`;
      if (blockers.includes(holder.pid)) { isBlocked = true; break; }
      await delay(20);
    }
    assert.ok(isBlocked, 'assignment rebuild must wait for the in-flight call aggregate lock');
    assert.equal(await prisma.callLog.count({ where: { customerId } }), 0);
    assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entryId } })).ownerUserId, creId);
    const callResult = message(first, 'result');
    const assignmentResult = message(second, 'result');
    first.send({ action: 'release' });
    assert.equal((await callResult).status, 201);
    assert.equal((await assignmentResult).status, 200);
    assert.equal(await prisma.callLog.count({ where: { customerId } }), 1);
    assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entryId } })).ownerUserId, nextCreId);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope } })).revision, initial.revision + 2n);
    releaseRefresh();
    assert.deepEqual(await refresh, { refreshed: false, reason: 'dirty' });
    refresh = null;
    const snapshot = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(snapshot.status, 'dirty');
    assert.equal(snapshot.dirtyVersion, 2n);
    assert.equal(snapshot.callsThisMonth, 7);
    assert.deepEqual((await auditCreCallAggregates(prisma, creId)).mismatches, []);
    assert.equal(await prisma.creCallDaily.count({ where: { userId: creId, scopeKind: 'OWNED', calls: { gt: 0 } } }), 0);

    const reverseAssignment = start('assignment', { hold: true, assignee: creId });
    await message(reverseAssignment, 'ready');
    const assignmentHolding = message(reverseAssignment, 'before-flush');
    reverseAssignment.send({ action: 'start' });
    await assignmentHolding;
    const reverseCall = start('call', { hold: true, caller: nextCreId });
    await message(reverseCall, 'ready');
    const callFlushing = message(reverseCall, 'before-flush');
    reverseCall.send({ action: 'start' });
    await callFlushing;
    const reverseCallResult = message(reverseCall, 'result');
    reverseCall.send({ action: 'release' });
    assert.equal((await reverseCallResult).status, 201);
    assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entryId } })).ownerUserId, nextCreId);
    const reverseAssignmentResult = message(reverseAssignment, 'result');
    reverseAssignment.send({ action: 'release' });
    assert.equal((await reverseAssignmentResult).status, 200);
    assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entryId } })).ownerUserId, creId);
    assert.equal(await prisma.callLog.count({ where: { customerId } }), 2);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope } })).revision, initial.revision + 4n);
    const afterReverse = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(afterReverse.status, 'dirty');
    assert.equal(afterReverse.dirtyVersion, 4n);
    assert.equal(afterReverse.callsThisMonth, 7);
    assert.deepEqual((await auditCreCallAggregates(prisma, creId)).mismatches, []);
    assert.deepEqual((await auditCreCallAggregates(prisma, nextCreId)).mismatches, []);
    assert.equal(await prisma.creCallDaily.count({ where: { userId: nextCreId, scopeKind: 'OWNED', calls: { gt: 0 } } }), 0);
  } finally {
    if (refresh) { releaseRefresh(); await refresh; }
    for (const child of workers) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await prisma.auditLog.deleteMany({ where: { userId: ccmUserId } });
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId } });
    await prisma.creCallDaily.deleteMany({ where: { ccmId } });
    await prisma.callLog.deleteMany({ where: { customerId } });
    await prisma.masterCallList.deleteMany({ where: { ccmId } });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.physicalVehicle.deleteMany({ where: { vin } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope } });
    await prisma.user.deleteMany({ where: { id: { in: [creId, nextCreId, ccmUserId] } } });
    await prisma.$disconnect();
  }
});
