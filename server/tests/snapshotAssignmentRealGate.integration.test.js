import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response() {
  return {
    locals: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('real reassignment transactions queue across CCMs when a hypothetical global gate is held', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { updateCallListAssignee } = await import('../src/controllers/recordsController.js');
  const observer = new pg.Client({ connectionString: databaseUrl });
  await observer.connect();
  const prefix = randomUUID();
  const groups = [0, 1].map((index) => ({
    team: `${prefix}-team-${index}`,
    actor: `${prefix}-ccm-${index}`,
    cre: `${prefix}-cre-${index}`,
    customer: `${prefix}-customer-${index}`,
    physical: `${prefix}-physical-${index}`,
    vehicle: `${prefix}-vehicle-${index}`,
    entry: `${prefix}-entry-${index}`,
    vin: `${prefix}-vin-${index}`,
  }));
  const transaction = prisma.$transaction;
  const gate = `investigation-only:${prefix}`;

  async function scenario(useGate) {
    await prisma.masterCallList.updateMany({
      where: { id: { in: groups.map(({ entry }) => entry) } },
      data: { ownerUserId: null },
    });

    const firstStarted = deferred();
    const release = deferred();
    const secondPid = deferred();
    const waits = [];
    let order = 0;
    prisma.$transaction = (work, ...options) => {
      if (typeof work !== 'function') return transaction(work, ...options);
      const current = order++;
      return transaction(async (tx) => {
        const [identity] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        if (current === 1) secondPid.resolve(identity.pid);
        const start = performance.now();
        if (useGate) {
          await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${gate}, 0))) AS gate_lock`;
        }
        waits[current] = performance.now() - start;
        if (current === 0) {
          firstStarted.resolve();
          await release.promise;
        }
        return work(tx);
      }, ...options);
    };
    const invoke = async (group) => {
      const res = response();
      const start = performance.now();
      await updateCallListAssignee({
        params: { id: group.entry },
        body: { assigneeId: group.cre },
        user: { id: group.actor, role: 'CCM', ccmId: group.team },
      }, res);
      assert.equal(res.statusCode, 200);
      return performance.now() - start;
    };
    let first;
    let second;
    try {
      first = invoke(groups[0]);
      await firstStarted.promise;
      second = invoke(groups[1]);
      const pid = await secondPid.promise;
      if (useGate) {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await observer.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid]);
          if (result.rows[0].n > 0) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(blocked, 'Second CCM assignment must wait on the experimental gate');
        await new Promise((resolve) => setTimeout(resolve, 200));
      } else {
        await second;
      }
      release.resolve();
      const durations = await Promise.all([first, second]);
      return { gateWaitMs: waits[1], durations };
    } finally {
      release.resolve();
      await Promise.allSettled([first, second].filter(Boolean));
      prisma.$transaction = transaction;
    }
  }

  try {
    await prisma.user.createMany({ data: groups.flatMap((group) => [
      { id: group.actor, name: 'Test CCM', password: 'test', role: 'CCM', ccmId: group.team },
      { id: group.cre, name: 'Test CRE', password: 'test', role: 'CRE', ccmId: group.team, status: 'active' },
    ]) });
    for (const group of groups) {
      await prisma.customer.create({ data: { id: group.customer, customerCode: group.customer, fullName: 'Test', ccmId: group.team } });
      await prisma.physicalVehicle.create({ data: { id: group.physical, vin: group.vin } });
      await prisma.vehicle.create({ data: {
        id: group.vehicle, vin: group.vin, physicalVehicleId: group.physical,
        customerId: group.customer, ccmId: group.team,
      } });
      await prisma.masterCallList.create({ data: {
        id: group.entry, customerName: 'Test', mobileNumber: '000',
        vin: group.vin, vehicleId: group.vehicle, ccmId: group.team,
      } });
    }
    const baseline = await scenario(false);
    const gated = await scenario(true);
    assert.ok(gated.gateWaitMs >= 150);
    const sources = await prisma.masterCallList.findMany({
      where: { id: { in: groups.map(({ entry }) => entry) } },
      select: { ccmId: true, ownerUserId: true, vehicleId: true },
      orderBy: { ccmId: 'asc' },
    });
    assert.deepEqual(sources, groups.map((group) => ({
      ccmId: group.team, ownerUserId: group.cre, vehicleId: group.vehicle,
    })).sort((a, b) => a.ccmId.localeCompare(b.ccmId)));
    const projectionCount = await prisma.creVehicleAssignmentProjection.count({
      where: { vehicleId: { in: groups.map(({ vehicle }) => vehicle) } },
    });
    assert.equal(projectionCount, 0, 'Existing writers do not maintain the staging projection');
    console.log(JSON.stringify({ kind: 'real-reassignment-gate-investigation', baseline, gated }));
  } finally {
    prisma.$transaction = transaction;
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId: { in: groups.map(({ team }) => team) } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: groups.map(({ actor }) => actor) } } });
    await prisma.creCallDaily.deleteMany({ where: { userId: { in: groups.map(({ cre }) => cre) } } });
    await prisma.masterCallList.deleteMany({ where: { id: { in: groups.map(({ entry }) => entry) } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: groups.map(({ vehicle }) => vehicle) } } });
    await prisma.physicalVehicle.deleteMany({ where: { id: { in: groups.map(({ physical }) => physical) } } });
    await prisma.customer.deleteMany({ where: { id: { in: groups.map(({ customer }) => customer) } } });
    await prisma.user.deleteMany({ where: { id: { in: groups.flatMap(({ cre, actor }) => [cre, actor]) } } });
    await observer.end();
    await prisma.$disconnect();
  }
});

test('real reassignment bypasses the experimental projection lock and can leave a stale projection', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { updateCallListAssignee } = await import('../src/controllers/recordsController.js');
  const { withCreAssignmentProjectionWrites } = await import('../src/utils/creAssignmentProjection.js');
  const id = randomUUID();
  const team = `${id}-team`;
  const actor = `${id}-actor`;
  const oldCre = `${id}-old`;
  const newCre = `${id}-new`;
  const customer = `${id}-customer`;
  const vehicle = `${id}-vehicle`;
  const physical = `${id}-physical`;
  const entry = `${id}-entry`;
  const ready = deferred();
  const release = deferred();
  let pending;
  try {
    await prisma.user.createMany({ data: [
      { id: actor, name: 'CCM', password: 'test', role: 'CCM', ccmId: team },
      { id: oldCre, name: 'Old CRE', password: 'test', role: 'CRE', ccmId: team, status: 'active' },
      { id: newCre, name: 'New CRE', password: 'test', role: 'CRE', ccmId: team, status: 'active' },
    ] });
    await prisma.customer.create({ data: { id: customer, customerCode: customer, fullName: 'Test', ccmId: team } });
    await prisma.physicalVehicle.create({ data: { id: physical, vin: id } });
    await prisma.vehicle.create({ data: { id: vehicle, vin: id, physicalVehicleId: physical, customerId: customer, ccmId: team } });
    await prisma.masterCallList.create({ data: {
      id: entry, customerName: 'Test', mobileNumber: '000', vin: id,
      vehicleId: vehicle, ccmId: team, ownerUserId: oldCre,
    } });
    const pausedDatabase = {
      $transaction: (work, options) => prisma.$transaction(async (tx) => {
        const result = await work(tx);
        ready.resolve();
        await release.promise;
        return result;
      }, options),
    };
    pending = withCreAssignmentProjectionWrites(pausedDatabase, [vehicle], async () => {});
    await ready.promise;
    const res = response();
    await updateCallListAssignee({
      params: { id: entry }, body: { assigneeId: newCre },
      user: { id: actor, role: 'CCM', ccmId: team },
    }, res);
    assert.equal(res.statusCode, 200);
    release.resolve();
    await pending;
    pending = null;
    const source = await prisma.masterCallList.findUniqueOrThrow({
      where: { id: entry }, select: { ownerUserId: true, vehicleId: true },
    });
    const rows = await prisma.creVehicleAssignmentProjection.findMany({ where: { vehicleId: vehicle } });
    assert.equal(source.ownerUserId, newCre);
    assert.deepEqual(rows.map(({ creId }) => creId), [oldCre]);
    await withCreAssignmentProjectionWrites(prisma, [vehicle], async () => {});
    const repaired = await prisma.creVehicleAssignmentProjection.findMany({ where: { vehicleId: vehicle } });
    assert.deepEqual(repaired.map(({ creId }) => creId), [newCre]);
  } finally {
    release.resolve();
    if (pending) await pending;
    await prisma.creVehicleAssignmentProjection.deleteMany({ where: { vehicleId: vehicle } });
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId: team } });
    await prisma.auditLog.deleteMany({ where: { userId: actor } });
    await prisma.creCallDaily.deleteMany({ where: { userId: { in: [oldCre, newCre] } } });
    await prisma.masterCallList.deleteMany({ where: { id: entry } });
    await prisma.vehicle.deleteMany({ where: { id: vehicle } });
    await prisma.physicalVehicle.deleteMany({ where: { id: physical } });
    await prisma.customer.deleteMany({ where: { id: customer } });
    await prisma.user.deleteMany({ where: { id: { in: [actor, oldCre, newCre] } } });
    await prisma.$disconnect();
  }
});
