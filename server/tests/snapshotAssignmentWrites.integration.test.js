import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('projection write primitive serializes grant sources and rolls back atomically', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { withCreAssignmentProjectionWrites } = await import('../src/utils/creAssignmentProjection.js');
  const prefix = randomUUID();
  const ccmId = `${prefix}-team`;
  const creId = `${prefix}-cre`;
  const customerId = `${prefix}-customer`;
  const vehicleIds = [`${prefix}-vehicle-a`, `${prefix}-vehicle-b`];
  const masterId = `${prefix}-master`;
  const allocationId = `${prefix}-allocation`;
  let releaseFirst;
  let firstEntered;
  let secondEntered;
  const firstStarted = new Promise((resolve) => { firstEntered = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  const secondStarted = new Promise((resolve) => { secondEntered = resolve; });
  const projection = () => prisma.creVehicleAssignmentProjection.findMany({
    where: { vehicleId: { in: vehicleIds } },
    orderBy: { vehicleId: 'asc' },
  });
  try {
    await prisma.user.create({ data: { id: creId, name: 'Test CRE', password: 'test', role: 'CRE', ccmId } });
    await prisma.customer.create({ data: { id: customerId, customerCode: customerId, fullName: 'Test customer', ccmId } });
    await prisma.physicalVehicle.createMany({ data: vehicleIds.map((id) => ({ id, vin: id })) });
    await prisma.vehicle.createMany({ data: vehicleIds.map((id) => ({
      id, vin: id, physicalVehicleId: id, customerId, ccmId,
    })) });
    const first = withCreAssignmentProjectionWrites(prisma, [vehicleIds[0]], async (tx) => {
      await tx.masterCallList.create({ data: {
        id: masterId, customerName: 'Test', mobileNumber: '000', ccmId,
        vin: vehicleIds[0], vehicleId: vehicleIds[0], ownerUserId: creId,
      } });
      firstEntered();
      await release;
    });
    await firstStarted;
    const second = withCreAssignmentProjectionWrites(prisma, [vehicleIds[0]], async (tx) => {
      secondEntered();
      await tx.allocation.create({ data: {
        id: allocationId, vehicleId: vehicleIds[0], ccmId, creId, serviceType: 'SERVICE',
      } });
    });
    try {
      assert.equal(await Promise.race([secondStarted.then(() => 'entered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 150))]), 'waiting');
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    assert.deepEqual(await projection(), [{
      ccmId, creId, vehicleId: vehicleIds[0], fromMaster: true, fromAllocation: true,
    }]);

    await withCreAssignmentProjectionWrites(prisma, [vehicleIds[0]], (tx) => tx.masterCallList.update({
      where: { id: masterId }, data: { ownerUserId: null },
    }));
    assert.deepEqual(await projection(), [{
      ccmId, creId, vehicleId: vehicleIds[0], fromMaster: false, fromAllocation: true,
    }]);

    const rollback = new Error('injected mutation failure');
    await assert.rejects(withCreAssignmentProjectionWrites(prisma, vehicleIds, async (tx) => {
      await tx.allocation.update({ where: { id: allocationId }, data: { status: 'cancelled' } });
      throw rollback;
    }), (error) => error === rollback);
    assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: allocationId } })).status, 'assigned');
    assert.equal((await projection())[0].fromAllocation, true);

    const refreshFailure = new Error('injected projection insert failure');
    const failingDb = {
      $transaction: (work, options) => prisma.$transaction((tx) => {
        let writes = 0;
        const proxy = new Proxy(tx, {
          get(target, property) {
            if (property === '$executeRaw') {
              return (...args) => {
                if (++writes === 2) throw refreshFailure;
                return target.$executeRaw(...args);
              };
            }
            return Reflect.get(target, property, target);
          },
        });
        return work(proxy);
      }, options),
    };
    await assert.rejects(withCreAssignmentProjectionWrites(failingDb, [vehicleIds[0]], (tx) => tx.allocation.update({
      where: { id: allocationId }, data: { status: 'cancelled' },
    })), (error) => error === refreshFailure);
    assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: allocationId } })).status, 'assigned');
    assert.equal((await projection())[0].fromAllocation, true);

    await withCreAssignmentProjectionWrites(prisma, [vehicleIds[1], vehicleIds[0], vehicleIds[0]], async (tx) => {
      await tx.masterCallList.update({ where: { id: masterId }, data: { vehicleId: vehicleIds[1], ownerUserId: creId } });
      await tx.allocation.update({ where: { id: allocationId }, data: { status: 'cancelled' } });
    });
    assert.deepEqual(await projection(), [{
      ccmId, creId, vehicleId: vehicleIds[1], fromMaster: true, fromAllocation: false,
    }]);

    let firstEnteredMulti;
    let releaseMulti;
    let secondEnteredMulti;
    const firstMultiStarted = new Promise((resolve) => { firstEnteredMulti = resolve; });
    const releaseFirstMulti = new Promise((resolve) => { releaseMulti = resolve; });
    const secondMultiStarted = new Promise((resolve) => { secondEnteredMulti = resolve; });
    const multiFirst = withCreAssignmentProjectionWrites(prisma, [vehicleIds[0], vehicleIds[1]], async () => {
      firstEnteredMulti();
      await releaseFirstMulti;
    });
    await firstMultiStarted;
    const multiSecond = withCreAssignmentProjectionWrites(prisma, [vehicleIds[1], vehicleIds[0]], async () => {
      secondEnteredMulti();
    });
    try {
      assert.equal(await Promise.race([
        secondMultiStarted.then(() => 'entered'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 150)),
      ]), 'waiting');
    } finally {
      releaseMulti();
    }
    await Promise.all([multiFirst, multiSecond]);
    assert.deepEqual(await projection(), [{
      ccmId, creId, vehicleId: vehicleIds[1], fromMaster: true, fromAllocation: false,
    }]);
  } finally {
    releaseFirst?.();
    await prisma.creVehicleAssignmentProjection.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
    await prisma.allocation.deleteMany({ where: { id: allocationId } });
    await prisma.masterCallList.deleteMany({ where: { id: masterId } });
    await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    await prisma.physicalVehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { id: creId } });
    await prisma.$disconnect();
  }
});
