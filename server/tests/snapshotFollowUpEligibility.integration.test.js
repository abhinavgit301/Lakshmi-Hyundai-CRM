import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('streamed follow-up eligibility matches legacy with PostgreSQL history visibility across batches', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { excludeIneligibleFreeServiceFollowUps } = await import('../src/utils/serviceLists.js');
  const prefix = randomUUID();
  const team = `${prefix}-team`;
  const cre = `${prefix}-cre`;
  const otherCre = `${prefix}-other`;
  const customer = `${prefix}-customer`;
  const ids = Array.from({ length: 501 }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);
  const now = new Date();
  const saleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 45);
  const visitDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 25);
  const rollback = new Error('rollback synthetic follow-up fixture');
  const flag = 'FREE_SERVICE_FOLLOW_UP_STREAMED_ELIGIBILITY_ENABLED';
  const previous = process.env[flag];
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.user.createMany({ data: [cre, otherCre].map((id) => ({
        id, name: 'Test CRE', password: 'test', role: 'CRE', ccmId: team,
      })) });
      await tx.customer.create({ data: { id: customer, customerCode: customer, fullName: 'Test', ccmId: team } });
      await tx.physicalVehicle.createMany({ data: ids.map((id) => ({ id, vin: id })) });
      await tx.vehicle.createMany({ data: ids.map((id) => ({
        id, vin: id, customerId: customer, physicalVehicleId: id, ccmId: team, saleDate,
      })) });
      await tx.masterCallList.createMany({ data: ids.map((id, i) => ({
        id: `${id}-master`, vin: id, vehicleId: id, ccmId: team,
        ownerUserId: i === 499 ? otherCre : cre, customerName: 'Test', mobileNumber: '000',
      })) });
      await tx.freeServiceMilestone.create({ data: {
        id: `${ids[0]}-milestone`, vehicleId: ids[0], physicalVehicleId: ids[0],
        milestone: 1, dueDate: now,
      } });
      await tx.workshopVisit.createMany({ data: [0, 499, 500].map((i) => ({
        id: `${ids[i]}-visit`, repairOrderNo: `${ids[i]}-ro`, normalizedRepairOrderNo: `${ids[i]}-ro`,
        customerId: customer, vehicleId: ids[i], physicalVehicleId: ids[i], ccmId: team,
        visitDate, importedDetails: { workType: i === 0 ? 'Free Service' : 'Paid Service' },
      })) });
      await tx.followUp.createMany({ data: [
        ...ids.map((id, i) => ({
          id: `${id}-follow`, customerId: customer, vehicleId: id, ccmId: team,
          creId: cre, source: 'FREE_SERVICE', followUpAt: now, category: 'follow-up',
          ...(i === 0 ? { milestoneId: `${id}-milestone` } : {}),
        })),
        { id: `${prefix}-unlinked`, customerId: customer, ccmId: team, creId: cre,
          source: 'FREE_SERVICE', followUpAt: now, category: 'follow-up' },
      ] });

      const base = { ccmId: team, source: 'FREE_SERVICE', status: 'pending' };
      for (const role of ['CRE', 'CCM']) {
        const user = { id: cre, ccmId: team, role };
        delete process.env[flag];
        const legacyFilter = await excludeIneligibleFreeServiceFollowUps(base, user, tx);
        const legacy = await tx.followUp.findMany({ where: legacyFilter, select: { id: true }, orderBy: { id: 'asc' } });
        process.env[flag] = 'true';
        const streamedFilter = await excludeIneligibleFreeServiceFollowUps(base, user, tx);
        const streamed = await tx.followUp.findMany({ where: streamedFilter, select: { id: true }, orderBy: { id: 'asc' } });
        assert.deepEqual(streamed, legacy);
        const visible = new Set(streamed.map(({ id }) => id));
        assert.equal(visible.has(`${ids[0]}-follow`), false);
        assert.equal(visible.has(`${ids[500]}-follow`), false);
        assert.equal(visible.has(`${prefix}-unlinked`), false);
        assert.equal(visible.has(`${ids[499]}-follow`), role === 'CRE');
      }
      throw rollback;
    }, { timeout: 20000 }), (error) => error === rollback);
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
    await prisma.$disconnect();
  }
});
