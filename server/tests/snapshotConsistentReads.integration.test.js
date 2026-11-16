import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('both loaders read one PostgreSQL snapshot and reject publication after a concurrent write', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const { computeCrePerformanceMetrics } = await import('../src/controllers/callWorkflowController.js');
  const { invalidateSnapshotSourceWrite } = await import('../src/utils/performanceSnapshotState.js');
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  const cre = { id: `${id}-cre`, ccmId, name: 'Test CRE', role: 'CRE', password: 'test' };
  const freeCre = { id: `${id}-free`, ccmId, name: 'Free CRE', role: 'FREE_SERVICE_CRE', password: 'test' };
  const customerId = `${id}-customer`;
  const vehicleId = `${id}-vehicle`;
  const physicalVehicleId = `${id}-physical`;
  const vin = `${id}-vin`;
  const now = new Date('2026-11-14T06:00:00Z');
  const key = { creId: cre.id, ccmId, year: 2026, month: 11, viewer: 'CRE' };
  const params = { targetCre: cre, viewer: 'CRE', year: 2026, month: 11, now };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  let release;
  let pending;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.create({ data: cre });
    await prisma.customer.create({ data: { id: customerId, customerCode: id, fullName: 'Test customer', ccmId } });
    await prisma.physicalVehicle.create({ data: { id: physicalVehicleId, vin } });
    await prisma.vehicle.create({ data: {
      id: vehicleId, vin, ccmId, physicalVehicleId, customerId, saleDate: new Date('2022-01-01T00:00:00Z'),
    } });
    await prisma.masterCallList.create({ data: {
      vin, ccmId, vehicleId, ownerUserId: cre.id, customerName: 'Test customer', mobileNumber: '9000000000',
    } });
    await prisma.workshopVisit.create({ data: {
      id: `${id}-old`, vehicleId, physicalVehicleId, customerId, ccmId,
      repairOrderNo: `${id}-old`, normalizedRepairOrderNo: `${id}-old`, visitDate: new Date('2024-01-01T00:00:00Z'),
      importedDetails: { workType: 'Paid Service' },
    } });
    await prisma.crePerformanceSnapshot.create({ data: {
      ...key, status: 'ok', callsThisMonth: 7, computedAt: now,
    } });

    for (const slim of [false, true]) {
      process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = String(slim);
      await prisma.workshopVisit.deleteMany({ where: { id: `${id}-new` } });
      await prisma.followUp.deleteMany({ where: { ccmId } });
      await prisma.followUp.create({ data: {
        customerId, vehicleId, ccmId, creId: cre.id, source: 'SERVICE', followUpAt: now, category: 'follow-up',
      } });
      const before = await computeCrePerformanceMetrics(params);
      const entered = deferred();
      const gate = deferred();
      release = gate.resolve;
      let actual;
      let intercepted = false;
      pending = refreshSnapshot(key, {
        now,
        compute: async ({ db, ...args }) => {
          const reads = new Proxy(db, {
            get(target, prop) {
              const value = target[prop];
              if (prop !== 'masterCallList') return value;
              return new Proxy(value, {
                get(model, method) {
                  if (method !== 'findMany') return model[method];
                  return async (...callArgs) => {
                    const rows = await model.findMany(...callArgs);
                    if (!intercepted) {
                      intercepted = true;
                      entered.resolve();
                      await gate.promise;
                    }
                    return rows;
                  };
                },
              });

            },
          });
          const finish = await computeCrePerformanceMetrics({ ...args, db: reads });
          return async () => {
            await assert.rejects(db.$queryRaw`SELECT 1`, /transaction|closed/i);
            actual = await finish();
            return actual;
          };
        },
      });
      await entered.promise;
      await prisma.$transaction(async (tx) => {
        await tx.workshopVisit.create({ data: {
          id: `${id}-new`, vehicleId, physicalVehicleId, customerId, ccmId,
          repairOrderNo: `${id}-new`, normalizedRepairOrderNo: `${id}-new`, visitDate: new Date('2026-10-01T00:00:00Z'),
          importedDetails: { workType: 'Paid Service' },
        } });
        await tx.followUp.updateMany({ where: { ccmId }, data: { status: 'completed' } });
        await invalidateSnapshotSourceWrite(tx);
      });
      gate.resolve();
      assert.deepEqual(await pending, { refreshed: false, reason: 'dirty' });
      pending = null;
      assert.deepEqual(actual, before);
      const after = await computeCrePerformanceMetrics(params);
      assert.notEqual(after.pendingFollowUps, before.pendingFollowUps);
      assert.notEqual(after.dueServicesCount, before.dueServicesCount);
      const row = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
      assert.equal(row.status, 'dirty');
      assert.equal(row.callsThisMonth, 7);
    }
    const clean = await refreshSnapshot(key, { now });
    assert.deepEqual(clean, { refreshed: true });
    const cleanRow = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(cleanRow.status, 'ok');
    const stable = await computeCrePerformanceMetrics(params);
    assert.equal(cleanRow.pendingFollowUps, stable.pendingFollowUps);
    assert.equal(cleanRow.dueServicesCount, stable.dueServicesCount);

    const failed = await refreshSnapshot(key, { now, compute: async ({ db }) => {
      const settings = await db.$queryRaw`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`;
      assert.equal(settings[0].isolation, 'repeatable read');
      assert.equal(settings[0].read_only, 'on');
      throw new Error('forced consistent read failure');
    } });
    assert.equal(failed.reason, 'failed');
    const failedRow = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(failedRow.callsThisMonth, cleanRow.callsThisMonth);
    assert.equal(failedRow.dueServicesCount, cleanRow.dueServicesCount);
    assert.equal(failedRow.status, 'failed');

    await prisma.user.create({ data: freeCre });
    await prisma.callLog.create({ data: {
      customerId, vehicleId, ccmId, createdById: freeCre.id,
      outcome: 'CONTACTED', callSource: 'FREE_SERVICE', createdAt: now,
    } });
    const freeKey = { ...key, creId: freeCre.id, viewer: 'FREE_SERVICE_CRE' };
    assert.deepEqual(await refreshSnapshot(freeKey, { now }), { refreshed: true });
    const freeRow = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: freeKey } });
    assert.equal(freeRow.callsThisMonth, 1);
  } finally {
    if (pending) { release(); await pending; }
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${ccmId}` } });
    await prisma.followUp.deleteMany({ where: { ccmId } });
    await prisma.callLog.deleteMany({ where: { ccmId } });
    await prisma.masterCallList.deleteMany({ where: { ccmId } });
    await prisma.workshopVisit.deleteMany({ where: { ccmId } });
    await prisma.vehicle.deleteMany({ where: { ccmId } });
    await prisma.physicalVehicle.deleteMany({ where: { id: physicalVehicleId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { id: { in: [cre.id, freeCre.id] } } });
    await prisma.$disconnect();
  }
});

test('a database read exceeding the transaction limit cannot publish', {
  skip: !databaseUrl, timeout: 95000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const id = randomUUID();
  const key = { creId: `${id}-cre`, ccmId: `${id}-ccm`, year: 2026, month: 11, viewer: 'CRE' };
  const now = new Date('2026-11-14T06:00:00Z');
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.create({ data: { id: key.creId, ccmId: key.ccmId, name: 'Test CRE', role: 'CRE', password: 'test' } });
    await prisma.crePerformanceSnapshot.create({ data: { ...key, status: 'ok', callsThisMonth: 7, computedAt: now } });
    const started = Date.now();
    const result = await refreshSnapshot(key, { now, compute: async ({ db }) => {
      await db.$queryRaw`SELECT 1 FROM pg_sleep(65)`;
      return { callsThisMonth: 99, details: {}, asOf: now };
    } });
    assert.equal(result.reason, 'failed');
    assert.match(String(result.error?.message), /timeout|expired|time limit/i);
    assert.ok(Date.now() - started < 68000, 'timed-out attempt must finish within the test bound');
    const row = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } });
    assert.equal(row.status, 'failed');
    assert.equal(row.callsThisMonth, 7);
  } finally {
    await prisma.crePerformanceSnapshot.deleteMany({ where: { creId: key.creId } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${key.ccmId}` } });
    await prisma.user.deleteMany({ where: { id: key.creId } });
    await prisma.$disconnect();
  }
});
