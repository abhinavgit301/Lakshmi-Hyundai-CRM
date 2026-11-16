import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('maintenance reconciliation is atomic, uses shared history and preserves visits', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { reconcileFreeServiceMilestones } = await import('../src/utils/reconcileFreeServiceMilestones.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const ccmIds = [`${id}-a`, `${id}-b`];
  let physical;
  let invalidPhysical;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    const customers = [];
    for (const ccmId of ccmIds) customers.push(await prisma.customer.create({ data: {
      customerCode: ccmId, fullName: 'Test', mobileNumber: '9000000000', ccmId,
    } }));
    physical = await prisma.physicalVehicle.create({ data: { vin: id } });
    const saleDate = new Date(2025, 0, 10);
    const vehicles = [];
    for (let i = 0; i < 2; i += 1) vehicles.push(await prisma.vehicle.create({ data: {
      id: `${i === 0 ? 'a' : 'b'}-${id}`, vin: id, physicalVehicleId: physical.id, customerId: customers[i].id, ccmId: ccmIds[i], saleDate,
    } }));
    const visit = await prisma.workshopVisit.create({ data: {
      repairOrderNo: id, normalizedRepairOrderNo: id.toUpperCase(), physicalVehicleId: physical.id,
      vehicleId: vehicles[1].id, customerId: customers[1].id, ccmId: ccmIds[1],
      visitDate: new Date(2025, 5, 11), importedDetails: { workType: 'Free Service' },
    } });
    for (const milestone of [1, 2, 3]) await prisma.freeServiceMilestone.create({ data: {
      vehicleId: vehicles[0].id, physicalVehicleId: physical.id, milestone,
      dueDate: new Date(2025, milestone * 2, 10),
      ...(milestone === 1 ? {
        status: 'completed', completedAt: visit.visitDate,
        completedByWorkshopVisitId: visit.id, completedByRepairOrderNo: visit.repairOrderNo,
      } : {}),
    } });
    const now = new Date(2025, 5, 12);
    const dryRun = await reconcileFreeServiceMilestones(prisma, { now });
    assert.equal(dryRun.updateCount, 2);
    let rows = await prisma.freeServiceMilestone.findMany({ where: { vehicleId: vehicles[0].id }, orderBy: { milestone: 'asc' } });
    assert.deepEqual(rows.map((row) => row.status), ['completed', 'pending', 'pending']);
    invalidPhysical = await prisma.physicalVehicle.create({ data: { vin: `invalid-${id}` } });
    const invalidVehicle = await prisma.vehicle.create({ data: {
      id: `z-${id}`, vin: invalidPhysical.vin, physicalVehicleId: invalidPhysical.id,
      customerId: customers[0].id, ccmId: ccmIds[0],
    } });
    await prisma.freeServiceMilestone.create({ data: {
      vehicleId: invalidVehicle.id, physicalVehicleId: invalidPhysical.id, milestone: 1, dueDate: new Date(2025, 2, 10),
    } });
    const blocked = await reconcileFreeServiceMilestones(prisma, { now });
    assert.equal(blocked.unresolved.length, 1);
    await assert.rejects(reconcileFreeServiceMilestones(prisma, { apply: true, now }), /Reconciliation aborted/);
    rows = await prisma.freeServiceMilestone.findMany({ where: { vehicleId: vehicles[0].id }, orderBy: { milestone: 'asc' } });
    assert.deepEqual(rows.map((row) => row.status), ['completed', 'pending', 'pending']);
    await prisma.freeServiceMilestone.deleteMany({ where: { vehicleId: invalidVehicle.id } });
    await prisma.vehicle.delete({ where: { id: invalidVehicle.id } });
    await prisma.physicalVehicle.delete({ where: { id: invalidPhysical.id } });
    invalidPhysical = null;
    const applied = await reconcileFreeServiceMilestones(prisma, { apply: true, now });
    assert.equal(applied.updateCount, 2);
    rows = await prisma.freeServiceMilestone.findMany({ where: { vehicleId: vehicles[0].id }, orderBy: { milestone: 'asc' } });
    assert.deepEqual(rows.map((row) => row.status), ['pending', 'completed', 'pending']);
    assert.equal(rows[1].completedByWorkshopVisitId, visit.id);
    assert.ok(await prisma.workshopVisit.findUnique({ where: { id: visit.id } }));
    assert.equal((await reconcileFreeServiceMilestones(prisma, { apply: true, now })).updateCount, 0);
    await prisma.vehicle.update({ where: { id: vehicles[0].id }, data: { saleDate: null } });
    await assert.rejects(reconcileFreeServiceMilestones(prisma, { apply: true, now }), /Reconciliation aborted/);
    rows = await prisma.freeServiceMilestone.findMany({ where: { vehicleId: vehicles[0].id }, orderBy: { milestone: 'asc' } });
    assert.equal(rows[1].completedByWorkshopVisitId, visit.id);
  } finally {
    if (physical) await prisma.freeServiceMilestone.deleteMany({ where: { physicalVehicleId: physical.id } });
    if (invalidPhysical) await prisma.freeServiceMilestone.deleteMany({ where: { physicalVehicleId: invalidPhysical.id } });
    if (physical) await prisma.workshopVisit.deleteMany({ where: { physicalVehicleId: physical.id } });
    await prisma.vehicle.deleteMany({ where: { ccmId: { in: ccmIds } } });
    await prisma.customer.deleteMany({ where: { ccmId: { in: ccmIds } } });
    if (physical) await prisma.physicalVehicle.delete({ where: { id: physical.id } });
    if (invalidPhysical) await prisma.physicalVehicle.delete({ where: { id: invalidPhysical.id } });
    await prisma.$disconnect();
  }
});
