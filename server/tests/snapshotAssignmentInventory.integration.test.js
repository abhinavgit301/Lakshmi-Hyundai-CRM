import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { creAssignmentLinksSql } from '../src/utils/creAssignmentSource.js';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

// Fixture-only rebuild; locks and transaction do not keep the projection current after commit.
async function rebuildCreAssignmentProjection(transaction) {
  await transaction.$executeRaw`LOCK TABLE "vehicles", "master_call_lists", "allocations" IN SHARE MODE NOWAIT`;
  await transaction.$executeRaw`LOCK TABLE "cre_vehicle_assignment_projection" IN ACCESS EXCLUSIVE MODE NOWAIT`;
  await transaction.$executeRaw`DELETE FROM "cre_vehicle_assignment_projection"`;
  return transaction.$executeRaw`
    INSERT INTO "cre_vehicle_assignment_projection" ("ccmId", "creId", "vehicleId", "fromMaster", "fromAllocation")
    ${creAssignmentLinksSql}
  `;
}

test('assignment inventory matches live ownership scopes on PostgreSQL', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { creCustomerWhere, creVehicleWhere } = await import('../src/utils/creAccess.js');
  const { readCreAssignmentInventory } = await import('../src/utils/creAssignmentInventory.js');
  const { reconcileCreAssignmentProjection } = await import('../src/utils/creAssignmentProjection.js');
  const suffix = randomUUID();
  const ccmId = `${suffix}-team`;
  const otherCcm = `${suffix}-other-team`;
  const creA = `${suffix}-cre-a`;
  const creB = `${suffix}-cre-b`;
  const customerId = `${suffix}-customer`;
  const ids = ['master', 'both', 'allocation'].map((name) => `${suffix}-${name}`);
  const rollback = new Error('rollback synthetic inventory fixture');
  try {
    const projectionBefore = await reconcileCreAssignmentProjection(prisma);
    await assert.rejects(prisma.$transaction(async (tx) => {
      const assertVehicleScopeParity = async () => {
        for (const team of [ccmId, otherCcm]) {
          for (const cre of [creA, creB]) {
            const vehicles = await tx.vehicle.findMany({
              where: { ccmId: team, ...creVehicleWhere({ id: cre, ccmId: team }) },
              select: { id: true },
              orderBy: { id: 'asc' },
            });
            const projected = await tx.creVehicleAssignmentProjection.findMany({
              where: { ccmId: team, creId: cre },
              select: { vehicleId: true },
              orderBy: { vehicleId: 'asc' },
            });
            assert.deepEqual(projected.map(({ vehicleId }) => vehicleId), vehicles.map(({ id }) => id));
          }
        }
      };
      const before = await readCreAssignmentInventory(tx);
      await tx.user.createMany({ data: [creA, creB].map((id) => ({
        id, name: 'Synthetic CRE', password: 'test', role: 'CRE', ccmId,
      })) });
      await tx.customer.create({ data: { id: customerId, customerCode: customerId, fullName: 'Synthetic customer', ccmId } });
      await tx.physicalVehicle.createMany({ data: ids.map((id) => ({ id, vin: id })) });
      await tx.vehicle.createMany({ data: ids.map((id) => ({
        id, vin: id, customerId, physicalVehicleId: id, ccmId,
      })) });
      await tx.masterCallList.createMany({ data: [
        { id: `${suffix}-master-entry`, customerName: 'Synthetic', mobileNumber: '000', ccmId, vin: ids[0], vehicleId: ids[0], ownerUserId: creA },
        { id: `${suffix}-both-entry`, customerName: 'Synthetic', mobileNumber: '000', ccmId, vin: ids[1], vehicleId: ids[1], ownerUserId: creA },
        { id: `${suffix}-duplicate`, customerName: 'Synthetic', mobileNumber: '000', ccmId, vin: ids[1], vehicleId: ids[1], ownerUserId: creA },
        { id: `${suffix}-unlinked`, customerName: 'Synthetic', mobileNumber: '000', ccmId, vin: `${suffix}-unlinked`, ownerUserId: creA },
      ] });
      await tx.allocation.createMany({ data: [
        { vehicleId: ids[1], ccmId, creId: creA, serviceType: 'SERVICE', status: 'assigned' },
        { vehicleId: ids[2], ccmId, creId: creB, serviceType: 'SERVICE', status: 'assigned' },
        { vehicleId: ids[0], ccmId, creId: creB, serviceType: 'SERVICE', status: 'cancelled' },
      ] });
      const after = await readCreAssignmentInventory(tx);
      const difference = Object.fromEntries(Object.keys(after).map((key) => [key, BigInt(after[key]) - BigInt(before[key])]));
      assert.deepEqual(difference, {
        vehicleLinks: 3n, customerLinks: 2n, masterOnly: 1n, allocationOnly: 1n, bothSources: 1n,
        ownedUnlinkedMasterEntries: 1n, crossTeamActiveAllocations: 0n,
      });

      assert.equal(await tx.vehicle.count({ where: { ccmId, ...creVehicleWhere({ id: creA, ccmId }) } }), 2);
      assert.equal(await tx.vehicle.count({ where: { ccmId, ...creVehicleWhere({ id: creB, ccmId }) } }), 1);
      assert.equal(await tx.customer.count({ where: creCustomerWhere({ id: creA, ccmId }) }), 1);
      assert.equal(await tx.customer.count({ where: creCustomerWhere({ id: creB, ccmId }) }), 1);
      const rebuilt = await rebuildCreAssignmentProjection(tx);
      assert.ok(rebuilt >= 3);
      assert.deepEqual(await reconcileCreAssignmentProjection(tx), { missing: '0', unexpected: '0', changed: '0' });
      await assertVehicleScopeParity();
      await tx.masterCallList.updateMany({
        where: { ccmId, vehicleId: ids[1] }, data: { ownerUserId: creB },
      });

      assert.deepEqual(await reconcileCreAssignmentProjection(tx), { missing: '1', unexpected: '0', changed: '1' });
      await tx.allocation.updateMany({
        where: { ccmId, creId: creB, vehicleId: ids[2], status: 'assigned' }, data: { status: 'cancelled' },
      });
      assert.deepEqual(await reconcileCreAssignmentProjection(tx), { missing: '1', unexpected: '1', changed: '1' });
      assert.deepEqual(await reconcileCreAssignmentProjection(tx, { vehicleIds: [ids[0]] }), {
        missing: '0', unexpected: '0', changed: '0',
      });
      assert.deepEqual(await reconcileCreAssignmentProjection(tx, { vehicleIds: [ids[1]] }), {
        missing: '1', unexpected: '0', changed: '1',
      });
      assert.deepEqual(await reconcileCreAssignmentProjection(tx, { vehicleIds: [ids[2]] }), {
        missing: '0', unexpected: '1', changed: '0',
      });
      assert.deepEqual(await reconcileCreAssignmentProjection(tx, { vehicleIds: [ids[1], ids[2]] }), {
        missing: '1', unexpected: '1', changed: '1',
      });
      await rebuildCreAssignmentProjection(tx);
      assert.deepEqual(await reconcileCreAssignmentProjection(tx), { missing: '0', unexpected: '0', changed: '0' });
      await assertVehicleScopeParity();

      await tx.masterCallList.update({
        where: { id: `${suffix}-unlinked` },
        data: { vehicleId: ids[2] },
      });
      await tx.vehicle.update({ where: { id: ids[0] }, data: { ccmId: otherCcm } });
      await rebuildCreAssignmentProjection(tx);
      assert.deepEqual(await reconcileCreAssignmentProjection(tx), { missing: '0', unexpected: '0', changed: '0' });
      await assertVehicleScopeParity();

      await tx.masterCallList.deleteMany({ where: { ccmId, vehicleId: ids[1] } });
      await tx.allocation.updateMany({
        where: { ccmId, creId: creA, vehicleId: ids[1] },
        data: { status: 'cancelled' },
      });
      await rebuildCreAssignmentProjection(tx);
      assert.deepEqual(await reconcileCreAssignmentProjection(tx), { missing: '0', unexpected: '0', changed: '0' });
      await assertVehicleScopeParity();
      throw rollback;
    }, { timeout: 20000 }), (error) => error === rollback);
    assert.deepEqual(await reconcileCreAssignmentProjection(prisma), projectionBefore);
  } finally {
    await prisma.$disconnect();
  }
});

test('projection rebuild refuses to wait for an active assignment writer', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  url.searchParams.delete('schema');
  const { prisma } = await import('../src/config/prisma.js');
  const writer = new pg.Client({ connectionString: url.toString() });
  await writer.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('LOCK TABLE allocations IN ROW EXCLUSIVE MODE');
    await assert.rejects(prisma.$transaction((tx) => rebuildCreAssignmentProjection(tx), { timeout: 5000 }),
      (error) => error.message.includes('could not obtain lock'));
  } finally {
    await writer.query('ROLLBACK');
    await writer.end();
    await prisma.$disconnect();
  }
});
