import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('chunked due cohorts match full scan and CRE/CCM scope in PostgreSQL', {
  skip: !databaseUrl, timeout: 60000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { classifyDueCohorts, creDueWhere, loadCallListRecords, loadDueCohorts } = await import('../src/controllers/recordsController.js');
  const prefix = randomUUID();
  const ccmId = `${prefix}-team`;
  const creId = `${prefix}-cre`;
  const otherCreId = `${prefix}-other`;
  const customerId = `${prefix}-customer`;
  const ids = Array.from({ length: 503 }, (_, index) => `${prefix}-${String(index).padStart(3, '0')}`);
  const asOf = new Date(2026, 10, 4, 10);
  const rollback = new Error('rollback synthetic due cohort fixture');
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.user.createMany({ data: [creId, otherCreId].map((id) => ({
        id, name: 'Test CRE', password: 'test', role: 'CRE', ccmId,
      })) });
      await tx.customer.create({ data: { id: customerId, customerCode: customerId, fullName: 'Test', ccmId } });
      await tx.physicalVehicle.createMany({ data: ids.map((id) => ({ id, vin: id })) });
      await tx.vehicle.createMany({ data: ids.map((id) => ({
        id, vin: id, customerId, physicalVehicleId: id, ccmId,
      })) });
      await tx.masterCallList.createMany({ data: ids.map((id, index) => ({
        id: `${id}-master`, vin: id, vehicleId: id, ccmId,
        ownerUserId: index === 501 ? otherCreId : creId, customerName: 'Test', mobileNumber: '000',
      })) });
      await tx.workshopVisit.createMany({ data: ids.map((id, index) => ({
        id: `${id}-visit`, repairOrderNo: `${id}-ro`, normalizedRepairOrderNo: `${id}-ro`,
        customerId, vehicleId: id, physicalVehicleId: id, ccmId,
        visitDate: index % 2 ? new Date(2026, 4, 10) : new Date(2025, 10, 10),
        importedDetails: { workType: 'Paid Service' },
      })) });
      for (const role of ['CRE', 'CCM']) {
        const user = { id: creId, ccmId, role };
        const where = role === 'CRE' ? creDueWhere(creId, ccmId) : { ccmId };
        const expected = classifyDueCohorts(await loadCallListRecords(where, asOf, user, { db: tx }), asOf);
        const actual = await loadDueCohorts(where, asOf, user, { db: tx });
        assert.deepEqual(actual, expected);
        const all = [...actual.oneYear, ...actual.sixMonth];
        assert.equal(all.length, role === 'CRE' ? 502 : 503);
        assert.equal(all.some((record) => record.id === `${ids[501]}-master`), role === 'CCM');
        assert.ok(all.some((record) => record.id === `${ids[502]}-master`));
      }
      throw rollback;
    }, { timeout: 45000 }), (error) => error === rollback);
  } finally {
    await prisma.$disconnect();
  }
});
