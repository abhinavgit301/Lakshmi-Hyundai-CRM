import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('projection backfill pages resume idempotently and serialize with a participating writer', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { backfillCreAssignmentProjectionPage, reconcileCreAssignmentProjection, withCreAssignmentProjectionWrites } = await import('../src/utils/creAssignmentProjection.js');
  const prefix = randomUUID();
  const team = `${prefix}-team`;
  const cre = `${prefix}-cre`;
  const customer = `${prefix}-customer`;
  const ids = ['a', 'b', 'c'].map((suffix) => `${prefix}-${suffix}`);
  const lateId = `${prefix}-0`;
  const scopedDb = {
    vehicle: { findMany: (args) => prisma.vehicle.findMany({
      ...args, where: { AND: [args.where, { id: { in: [...ids, lateId] } }] },
    }) },
    $transaction: (...args) => prisma.$transaction(...args),
  };
  const read = () => prisma.creVehicleAssignmentProjection.findMany({
    where: { vehicleId: { in: [...ids, lateId] } }, orderBy: { vehicleId: 'asc' },
  });
  let releaseWriter;
  let enteredWriter;
  const writerEntered = new Promise((resolve) => { enteredWriter = resolve; });
  const release = new Promise((resolve) => { releaseWriter = resolve; });
  let writer;
  let page;
  try {
    await prisma.user.create({ data: { id: cre, name: 'Test CRE', password: 'test', role: 'CRE', ccmId: team } });
    await prisma.customer.create({ data: { id: customer, customerCode: customer, fullName: 'Test', ccmId: team } });
    await prisma.physicalVehicle.createMany({ data: ids.map((id) => ({ id, vin: id })) });
    await prisma.vehicle.createMany({ data: ids.map((id) => ({ id, vin: id, customerId: customer, physicalVehicleId: id, ccmId: team })) });
    await prisma.masterCallList.createMany({ data: ids.map((id) => ({
      id: `${id}-master`, customerName: 'Test', mobileNumber: '000', ccmId: team,
      vehicleId: id, vin: id, ownerUserId: cre,
    })) });
    writer = withCreAssignmentProjectionWrites(prisma, [ids[0]], async (tx) => {
      await tx.allocation.create({ data: {
        id: `${prefix}-allocation`, vehicleId: ids[0], ccmId: team, creId: cre, serviceType: 'SERVICE',
      } });
      enteredWriter();
      await release;
    });
    await writerEntered;
    page = backfillCreAssignmentProjectionPage(scopedDb, { limit: 2 });
    try {
      assert.equal(await Promise.race([page.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 150))]), 'waiting');
    } finally {
      releaseWriter();
    }
    const [, first] = await Promise.all([writer, page]);
    assert.deepEqual(first, { processed: 2, nextAfterId: ids[1], hasMore: true });
    assert.deepEqual(await read(), ids.slice(0, 2).map((id, index) => ({
      ccmId: team, creId: cre, vehicleId: id, fromMaster: true, fromAllocation: index === 0,
    })));
    assert.deepEqual(await backfillCreAssignmentProjectionPage(scopedDb, { limit: 2 }), first);
    assert.deepEqual(await backfillCreAssignmentProjectionPage(scopedDb, { afterId: first.nextAfterId, limit: 2 }), {
      processed: 1, nextAfterId: ids[2], hasMore: false,
    });
    assert.equal((await read()).length, 3);
    await prisma.creVehicleAssignmentProjection.deleteMany({ where: { vehicleId: ids[2] } });
    assert.deepEqual(await reconcileCreAssignmentProjection(prisma, { vehicleIds: ids.slice(0, 2) }), {
      missing: '0', unexpected: '0', changed: '0',
    });
    assert.deepEqual(await reconcileCreAssignmentProjection(prisma, { vehicleIds: ids }), {
      missing: '1', unexpected: '0', changed: '0',
    });
    await backfillCreAssignmentProjectionPage(scopedDb, { afterId: first.nextAfterId, limit: 2 });
    assert.deepEqual(await backfillCreAssignmentProjectionPage(scopedDb, { afterId: ids[2], limit: 2 }), {
      processed: 0, nextAfterId: ids[2], hasMore: false,
    });

    await prisma.physicalVehicle.create({ data: { id: lateId, vin: lateId } });
    await withCreAssignmentProjectionWrites(prisma, [lateId], async (tx) => {
      await tx.vehicle.create({ data: { id: lateId, vin: lateId, customerId: customer, physicalVehicleId: lateId, ccmId: team } });
      await tx.masterCallList.create({ data: {
        id: `${lateId}-master`, customerName: 'Test', mobileNumber: '000',
        ccmId: team, vehicleId: lateId, vin: lateId, ownerUserId: cre,
      } });
    });
    assert.deepEqual((await read()).map(({ vehicleId }) => vehicleId), [lateId, ...ids]);
    assert.deepEqual(await backfillCreAssignmentProjectionPage(scopedDb, { afterId: ids[2], limit: 2 }), {
      processed: 0, nextAfterId: ids[2], hasMore: false,
    });

    await withCreAssignmentProjectionWrites(prisma, [ids[0]], async (tx) => {
      await tx.masterCallList.update({ where: { id: `${ids[0]}-master` }, data: { ownerUserId: null } });
      await tx.allocation.update({ where: { id: `${prefix}-allocation` }, data: { status: 'cancelled' } });
    });
    assert.deepEqual((await read()).map(({ vehicleId }) => vehicleId), [lateId, ...ids.slice(1)]);
    await backfillCreAssignmentProjectionPage(scopedDb, { afterId: lateId, limit: 2 });
    assert.deepEqual((await read()).map(({ vehicleId }) => vehicleId), [lateId, ...ids.slice(1)]);

    const failure = new Error('injected backfill failure');
    const failingDb = {
      ...scopedDb,
      $transaction: (work, options) => prisma.$transaction((tx) => work(new Proxy(tx, {
        get(target, property) {
          if (property === '$executeRaw') return () => { throw failure; };
          return Reflect.get(target, property, target);
        },
      })), options),
    };
    const before = await read();
    await assert.rejects(backfillCreAssignmentProjectionPage(failingDb, { limit: 2 }), (error) => error === failure);
    assert.deepEqual(await read(), before);
  } finally {
    releaseWriter();
    await Promise.allSettled([writer, page].filter(Boolean));
    const allIds = [...ids, lateId];
    await prisma.creVehicleAssignmentProjection.deleteMany({ where: { vehicleId: { in: allIds } } });
    await prisma.allocation.deleteMany({ where: { vehicleId: { in: allIds } } });
    await prisma.masterCallList.deleteMany({ where: { vehicleId: { in: allIds } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: allIds } } });
    await prisma.physicalVehicle.deleteMany({ where: { id: { in: allIds } } });
    await prisma.customer.deleteMany({ where: { id: customer } });
    await prisma.user.deleteMany({ where: { id: cre } });
    await prisma.$disconnect();
  }
});
