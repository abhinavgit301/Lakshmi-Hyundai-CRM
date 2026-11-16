import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('milestone reconciliation uses all CCM visits and repairs stale references', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { reconcilePhysicalVehicleMilestones } = await import('../src/utils/physicalVehicleMilestones.js');
  const id = randomUUID();
  const ccmIds = [`${id}-a`, `${id}-b`];
  let physical;
  try {
    const customers = [];
    for (const ccmId of ccmIds) customers.push(await prisma.customer.create({ data: {
      customerCode: ccmId, fullName: 'Test', mobileNumber: '9000000000', ccmId,
    } }));
    physical = await prisma.physicalVehicle.create({ data: { vin: id } });
    const saleDate = new Date(2025, 0, 1);
    const vehicles = [];
    for (let index = 0; index < ccmIds.length; index += 1) vehicles.push(await prisma.vehicle.create({ data: {
      id: `${index}-${id}`, vin: id, physicalVehicleId: physical.id, customerId: customers[index].id,
      ccmId: ccmIds[index], saleDate,
    } }));
    const visits = [];
    for (let index = 0; index < ccmIds.length; index += 1) visits.push(await prisma.workshopVisit.create({ data: {
      id: `${index}-${id}`, repairOrderNo: `same-ro-${id}`, normalizedRepairOrderNo: `SAME-RO-${id}`.toUpperCase(),
      physicalVehicleId: physical.id, vehicleId: vehicles[index].id, customerId: customers[index].id,
      ccmId: ccmIds[index], visitDate: new Date(2025, 5, 2), importedDetails: { workType: 'Free Service' },
    } }));
    await prisma.freeServiceMilestone.createMany({ data: [1, 2, 3].map((milestone) => ({
      vehicleId: vehicles[0].id,
      physicalVehicleId: physical.id,
      milestone,
      dueDate: new Date(2025, milestone * 2, 1),
      ...(milestone === 1 ? {
        status: 'completed',
        completedAt: visits[0].visitDate,
        completedByRepairOrderNo: visits[0].repairOrderNo,
        completedByWorkshopVisitId: visits[0].id,
      } : {}),
    })) });
    const result = await prisma.$transaction((transaction) => reconcilePhysicalVehicleMilestones(transaction, [physical.id]));
    assert.equal(result.changed, true);
    const milestones = await prisma.freeServiceMilestone.findMany({
      where: { vehicleId: vehicles[0].id },
      orderBy: { milestone: 'asc' },
    });
    assert.deepEqual(milestones.map((row) => row.status), ['pending', 'completed', 'completed']);
    assert.deepEqual(
      milestones.slice(1).map((row) => row.completedByWorkshopVisitId).sort(),
      visits.map((visit) => visit.id).sort(),
    );
    assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id } }), 2);
  } finally {
    if (physical) await prisma.freeServiceMilestone.deleteMany({ where: { physicalVehicleId: physical.id } });
    if (physical) await prisma.workshopVisit.deleteMany({ where: { physicalVehicleId: physical.id } });
    if (physical) await prisma.vehicle.deleteMany({ where: { physicalVehicleId: physical.id } });
    if (physical) await prisma.physicalVehicle.delete({ where: { id: physical.id } });
    await prisma.customer.deleteMany({ where: { ccmId: { in: ccmIds } } });
    await prisma.$disconnect();
  }
});
