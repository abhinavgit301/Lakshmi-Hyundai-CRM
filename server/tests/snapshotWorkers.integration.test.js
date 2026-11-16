import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;
const workerPath = fileURLToPath(new URL('../test-support/snapshotWorker.mjs', import.meta.url));

test('independent workers fence takeover, failure, crashes and writes immediately before publication', {
  skip: !databaseUrl, timeout: 45000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { createFollowUp } = await import('../src/controllers/callWorkflowController.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const key = { creId: `${id}-cre`, ccmId: `${id}-team`, year: 2026, month: 11, viewer: 'CRE' };
  const now = new Date('2026-11-14T06:00:00Z');
  const future = new Date(now.getTime() + 11 * 60000);
  const snapshotWhere = { creId_ccmId_year_month_viewer: key };
  const read = () => prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: snapshotWhere });
  const workers = new Set();
  function start(calls, time = now) {
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED: 'true',
        SNAPSHOT_WORKER_CASE: JSON.stringify({ key, now: time, calls }),
      },
    });

    workers.add(child);
    child.once('exit', () => workers.delete(child));
    return child;
  }
  async function message(child, expected) {
    const [event] = await once(child, 'message');
    assert.equal(event.type, expected, event.message);
    return event;
  }
  async function complete(child, action = 'success') {
    const result = message(child, 'result');
    child.send({ action });
    return (await result).result;
  }
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.create({ data: {
      id: key.creId, ccmId: key.ccmId, name: 'Test CRE', role: 'CRE', password: 'test',
    } });
    const customer = await prisma.customer.create({ data: {
      customerCode: id, fullName: 'Test customer', ccmId: key.ccmId,
    } });
    await prisma.crePerformanceSnapshot.create({ data: {
      ...key, status: 'ok', callsThisMonth: 7, computedAt: now,
    } });

    for (const [oldAction, replacementAction] of [
      ['success', 'success'],
      ['fail', 'success'],
      ['success', 'fail'],
      ['fail', 'fail'],
    ]) {
      const old = start(10);
      await message(old, 'ready');
      const replacement = start(20, future);
      await message(replacement, 'ready');
      const result = await complete(replacement, replacementAction);
      assert.equal(result.reason, replacementAction === 'fail' ? 'failed' : undefined);
      const before = await read();
      assert.equal(before.status, replacementAction === 'fail' ? 'failed' : 'ok');
      assert.equal(before.callsThisMonth, 20);
      assert.deepEqual(await complete(old, oldAction), { refreshed: false, reason: 'superseded' });
      const after = await read();
      assert.equal(after.status, before.status);
      assert.equal(after.callsThisMonth, before.callsThisMonth);
      assert.equal(after.failureCount, before.failureCount);
      assert.equal(after.lastError, before.lastError);
    }

    const killed = start(30);
    await message(killed, 'ready');
    const exited = once(killed, 'exit');
    killed.kill();
    await exited;
    assert.equal((await read()).status, 'refreshing');
    const replacement = start(40, future);
    await message(replacement, 'ready');
    assert.deepEqual(await complete(replacement), { refreshed: true });
    assert.equal((await read()).callsThisMonth, 40);

    const worker = start(50);
    await message(worker, 'ready');
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await createFollowUp({
      user: { id: key.creId, role: 'CCM', ccmId: key.ccmId },
      body: { customerId: customer.id, category: 'CALLBACK', followUpAt: new Date(Date.now() + 86400000).toISOString() },
    }, response);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(await complete(worker), { refreshed: false, reason: 'dirty' });
    const dirty = await read();
    assert.equal(dirty.status, 'dirty');
    assert.equal(dirty.callsThisMonth, 40);
    assert.equal(dirty.claimToken, null);
    const retry = start(60);
    await message(retry, 'ready');
    assert.deepEqual(await complete(retry), { refreshed: true });
    const clean = await read();
    assert.equal(clean.status, 'ok');
    assert.equal(clean.callsThisMonth, 60);
    assert.equal(clean.dirtySince, null);
  } finally {
    for (const child of workers) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await prisma.followUp.deleteMany({ where: { ccmId: key.ccmId } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { creId: key.creId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${key.ccmId}` } });
    await prisma.customer.deleteMany({ where: { ccmId: key.ccmId } });
    await prisma.user.deleteMany({ where: { id: key.creId } });
    await prisma.$disconnect();
  }
});
