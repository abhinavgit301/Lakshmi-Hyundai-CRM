import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('free-service history updates the customer profile and calling milestones', {
  skip: !databaseUrl, timeout: 30000,
}, async (t) => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { getCustomerById } = await import('../src/controllers/recordsController.js');
  const { getFreeServiceList } = await import('../src/controllers/serviceListsController.js');
  const { freeServiceCustomerIdsForMonth } = await import('../src/utils/serviceCalendar.js');
  const { invalidateCallListCache } = await import('../src/utils/callListCache.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const ccmId = `${id}-ccm`;
  const cre = { id: `${id}-cre`, ccmId, name: 'Test CRE', role: 'CRE', password: 'test', freeServiceEnabled: true };
  const today = new Date();
  const saleDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 50);
  const visitDate = new Date(saleDate.getFullYear(), saleDate.getMonth(), saleDate.getDate() + 21);
  const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  await t.test('a late first visit completes the second milestone across shared CCM history', {
    skip: !databaseUrl, timeout: 30000,
  }, async () => {
    const url = new URL(databaseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
    for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
    process.env.DATABASE_URL = databaseUrl;
    process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
    const { prisma } = await import('../src/config/prisma.js');
    const { getCustomerById } = await import('../src/controllers/recordsController.js');
    const { getFreeServiceList } = await import('../src/controllers/serviceListsController.js');
    const { freeServiceDueDate, freeServiceExpiryDate } = await import('../src/utils/serviceCalendar.js');
    const { invalidateCallListCache } = await import('../src/utils/callListCache.js');
    const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
    setSnapshotRefreshHandler(() => {});
    const id = randomUUID();
    const ccmId = `${id}-ccm`;
    const otherCcmId = `${id}-other`;
    const cre = { id: `${id}-cre`, ccmId, name: 'Test CRE', role: 'CRE', password: 'test', freeServiceEnabled: true };
    const today = new Date();
    const saleDate = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 7);
    const visitDate = freeServiceExpiryDate(freeServiceDueDate(saleDate, 1));
    visitDate.setDate(visitDate.getDate() + 1);
    const response = () => ({
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    });
    let physical;
    try {
      await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
      await prisma.user.create({ data: cre });
      const customer = await prisma.customer.create({ data: { customerCode: id, fullName: 'Test', mobileNumber: '9000000000', ccmId } });
      const otherCustomer = await prisma.customer.create({ data: { customerCode: `${id}-other`, fullName: 'Test', mobileNumber: '9000000000', ccmId: otherCcmId } });
      physical = await prisma.physicalVehicle.create({ data: { vin: id } });
      const vehicle = await prisma.vehicle.create({ data: { vin: id, physicalVehicleId: physical.id, customerId: customer.id, ccmId, saleDate } });
      const otherVehicle = await prisma.vehicle.create({ data: { vin: id, physicalVehicleId: physical.id, customerId: otherCustomer.id, ccmId: otherCcmId, saleDate } });
      await prisma.masterCallList.create({ data: {
        vin: id, ccmId, ownerUserId: cre.id, vehicleId: vehicle.id, customerName: 'Test', mobileNumber: '9000000000',
      } });
      await prisma.workshopVisit.create({ data: {
        repairOrderNo: id, normalizedRepairOrderNo: id.toUpperCase(), physicalVehicleId: physical.id,
        vehicleId: otherVehicle.id, customerId: otherCustomer.id, ccmId: otherCcmId, visitDate,
        importedDetails: { workType: 'Free Service' },
      } });
      invalidateCallListCache({ ccmIds: [ccmId] });
      const profile = response();
      await getCustomerById({ user: cre, params: { id: customer.id } }, profile);
      assert.equal(profile.body.customer.vehicles[0].freeServicesRemaining, 1);
      const list = response();
      await getFreeServiceList({ user: cre, query: {} }, list);
      assert.deepEqual(list.body.records, []);
      await prisma.workshopVisit.create({ data: {
        repairOrderNo: id, normalizedRepairOrderNo: id.toUpperCase(), physicalVehicleId: physical.id,
        vehicleId: vehicle.id, customerId: customer.id, ccmId, visitDate,
        importedDetails: { workType: 'Free Service' },
      } });
      invalidateCallListCache({ ccmIds: [ccmId] });
      const afterSecondVisit = response();
      await getCustomerById({ user: cre, params: { id: customer.id } }, afterSecondVisit);
      assert.equal(afterSecondVisit.body.customer.vehicles[0].freeServicesRemaining, 0);
    } finally {
      if (physical) await prisma.freeServiceMilestone.deleteMany({ where: { physicalVehicleId: physical.id } });
      await prisma.masterCallList.deleteMany({ where: { ccmId } });
      await prisma.workshopVisit.deleteMany({ where: { ccmId: { in: [ccmId, otherCcmId] } } });
      await prisma.vehicle.deleteMany({ where: { ccmId: { in: [ccmId, otherCcmId] } } });
      await prisma.customer.deleteMany({ where: { ccmId: { in: [ccmId, otherCcmId] } } });
      if (physical) await prisma.physicalVehicle.delete({ where: { id: physical.id } });
      await prisma.user.deleteMany({ where: { id: cre.id } });
      await prisma.$disconnect();
    }
  });
  let customer;
  let vehicle;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.create({ data: cre });
    customer = await prisma.customer.create({ data: { customerCode: id, fullName: 'Test', mobileNumber: '9000000000', ccmId } });
    const physical = await prisma.physicalVehicle.create({ data: { vin: id } });
    vehicle = await prisma.vehicle.create({ data: { vin: id, physicalVehicleId: physical.id, customerId: customer.id, ccmId, saleDate } });
    await prisma.masterCallList.create({ data: {
      vin: id, ccmId, ownerUserId: cre.id, vehicleId: vehicle.id, customerName: 'Test', mobileNumber: '9000000000',
    } });
    const req = { user: cre, query: {} };
    const before = response();
    await getFreeServiceList(req, before);
    assert.equal(before.body.records.length, 1);
    assert.equal(before.body.records[0].milestone, 1);

    await prisma.workshopVisit.create({ data: {
      repairOrderNo: id, normalizedRepairOrderNo: id.toUpperCase(), physicalVehicleId: physical.id,
      vehicleId: vehicle.id, customerId: customer.id, ccmId, visitDate,
      importedDetails: { serviceType: 'Free Service' },
    } });
    invalidateCallListCache({ ccmIds: [ccmId] });
    const profile = response();
    await getCustomerById({ user: cre, params: { id: customer.id } }, profile);
    assert.equal(profile.body.customer.visits.length, 1);
    assert.equal(profile.body.customer.vehicles[0].freeServicesRemaining, 2);
    const after = response();
    await getFreeServiceList(req, after);
    assert.deepEqual(after.body.records, []);
    const milestones = await prisma.freeServiceMilestone.findMany({ where: { vehicleId: vehicle.id }, orderBy: { milestone: 'asc' } });
    assert.deepEqual(milestones.map((row) => row.status), ['completed', 'pending', 'pending']);
    const nextDue = milestones[1].dueDate;
    const visits = await prisma.workshopVisit.findMany({ where: { physicalVehicleId: physical.id } });
    const nextMonth = freeServiceCustomerIdsForMonth(
      [{ customerId: customer.id, saleDate, workshopVisits: visits }],
      nextDue.getFullYear(), nextDue.getMonth() + 1, nextDue,
    );
    assert.ok(nextMonth.has(customer.id));
    const secondWindow = new Date(nextDue.getFullYear(), nextDue.getMonth(), nextDue.getDate() - 7, 12);
    t.mock.timers.enable({ apis: ['Date'], now: secondWindow });
    invalidateCallListCache({ ccmIds: [ccmId] });
    const second = response();
    await getFreeServiceList(req, second);
    assert.equal(second.body.records.length, 1);
    assert.equal(second.body.records[0].milestone, 2);
  } finally {
    if (vehicle) await prisma.freeServiceMilestone.deleteMany({ where: { vehicleId: vehicle.id } });
    await prisma.masterCallList.deleteMany({ where: { ccmId } });
    await prisma.workshopVisit.deleteMany({ where: { ccmId } });
    await prisma.vehicle.deleteMany({ where: { ccmId } });
    await prisma.customer.deleteMany({ where: { ccmId } });
    await prisma.physicalVehicle.deleteMany({ where: { vin: id } });
    await prisma.user.deleteMany({ where: { id: cre.id } });
    await prisma.$disconnect();
  }
});
