import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('concurrent milestone sync cannot overwrite a completion chosen by another request', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_ENABLED = 'false';
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'false';
  const { prisma } = await import('../src/config/prisma.js');
  const { syncFreeServiceMilestones } = await import('../src/utils/serviceLists.js');
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  let physical;
  try {
    const customer = await prisma.customer.create({ data: {
      customerCode: id, fullName: 'Test', mobileNumber: '9000000000', ccmId,
    } });
    physical = await prisma.physicalVehicle.create({ data: { vin: id } });
    const saleDate = new Date(2025, 0, 1);
    const vehicle = await prisma.vehicle.create({ data: {
      vin: id, physicalVehicleId: physical.id, customerId: customer.id, ccmId, saleDate,
    } });
    const visits = [];
    for (let i = 0; i < 2; i += 1) visits.push(await prisma.workshopVisit.create({ data: {
      repairOrderNo: `${id}-${i}`, normalizedRepairOrderNo: `${id}-${i}`.toUpperCase(),
      physicalVehicleId: physical.id, vehicleId: vehicle.id, customerId: customer.id, ccmId,
      visitDate: new Date(2025, 2, i + 1), importedDetails: { workType: 'Free Service' },
    } }));
    await prisma.freeServiceMilestone.createMany({ data: [1, 2, 3].map((milestone) => ({
      vehicleId: vehicle.id, physicalVehicleId: physical.id, milestone,
      dueDate: new Date(2025, milestone * 2, 1),
    })) });
    let arrivals = 0;
    let release;
    const bothRead = new Promise((resolve) => { release = resolve; });
    const counts = [];
    function database() {
      let firstRead = true;
      return { freeServiceMilestone: {
        findMany: async (args) => {
          const result = await prisma.freeServiceMilestone.findMany(args);
          if (firstRead) {
            firstRead = false;
            arrivals += 1;
            if (arrivals === 2) release();
            await bothRead;
          }
          return result;
        },
        createMany: (args) => prisma.freeServiceMilestone.createMany(args),
        updateMany: async (args) => {
          const result = await prisma.freeServiceMilestone.updateMany(args);
          counts.push(result.count);
          return result;
        },
      } };
    }
    await Promise.all(visits.map((visit) => syncFreeServiceMilestones([{
      id: vehicle.id, physicalVehicleId: physical.id, saleDate, workshopVisits: [visit],
    }], database())));
    assert.deepEqual(counts.sort(), [0, 1]);
    const milestone = await prisma.freeServiceMilestone.findUniqueOrThrow({
      where: { vehicleId_milestone: { vehicleId: vehicle.id, milestone: 1 } },
    });
    assert.equal(milestone.status, 'completed');
    assert.ok(visits.some((visit) => visit.id === milestone.completedByWorkshopVisitId));
  } finally {
    if (physical) {
      await prisma.freeServiceMilestone.deleteMany({ where: { physicalVehicleId: physical.id } });
      await prisma.workshopVisit.deleteMany({ where: { physicalVehicleId: physical.id } });
      await prisma.vehicle.deleteMany({ where: { physicalVehicleId: physical.id } });
      await prisma.physicalVehicle.delete({ where: { id: physical.id } });
    }
    await prisma.customer.deleteMany({ where: { ccmId } });
    await prisma.$disconnect();
  }
});
