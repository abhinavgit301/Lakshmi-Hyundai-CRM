import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('CCM SQL pages preserve legacy queue details while loading only page-related allocations', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { getCallList } = await import('../src/controllers/recordsController.js');
  const { invalidateCallListCache } = await import('../src/utils/callListCache.js');
  const prefix = randomUUID();
  const ccmId = `${prefix}-team`;
  const otherCcm = `${prefix}-other`;
  const customerId = `${prefix}-customer`;
  const otherCustomer = `${prefix}-other-customer`;
  const vehicleIds = ['master', 'queue-a', 'queue-b', 'queue-c'].map((part) => `${prefix}-${part}`);
  const originalFlag = process.env.MASTER_CALL_LIST_SQL_ENABLED;
  const originalFindAllocations = prisma.allocation.findMany;
  let allocationReads = [];
  const run = async (flag, query) => {
    process.env.MASTER_CALL_LIST_SQL_ENABLED = flag;
    invalidateCallListCache();
    allocationReads = [];
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getCallList({ user: { id: `${prefix}-ccm`, role: 'CCM', ccmId }, query }, res);
    assert.equal(res.statusCode, 200);
    return { body: res.body, reads: allocationReads };
  };
  try {
    await prisma.customer.createMany({ data: [
      { id: customerId, customerCode: customerId, fullName: 'Test customer', ccmId },
      { id: otherCustomer, customerCode: otherCustomer, fullName: 'Other customer', ccmId: otherCcm },
    ] });
    await prisma.physicalVehicle.createMany({ data: vehicleIds.map((id) => ({ id, vin: id })) });
    await prisma.vehicle.createMany({ data: [
      ...vehicleIds.map((id) => ({ id, vin: id, customerId, physicalVehicleId: id, ccmId })),
      { id: `${prefix}-other-vehicle`, vin: vehicleIds[0], customerId: otherCustomer, physicalVehicleId: vehicleIds[0], ccmId: otherCcm },
    ] });
    await prisma.masterCallList.create({ data: {
      id: `${prefix}-master`, customerName: 'Test customer', mobileNumber: '000',
      vin: vehicleIds[0], vehicleId: vehicleIds[0], ccmId,
    } });
    await prisma.allocation.createMany({ data: [
      ...vehicleIds.map((vehicleId, index) => ({
        id: `${prefix}-allocation-${index}`, vehicleId, ccmId, serviceType: 'SERVICE',
      })),
      { id: `${prefix}-duplicate`, vehicleId: vehicleIds[0], ccmId, serviceType: 'SERVICE' },
      { id: `${prefix}-other-allocation`, vehicleId: `${prefix}-other-vehicle`, ccmId: otherCcm, serviceType: 'SERVICE' },
    ] });
    prisma.allocation.findMany = async (args) => {
      const rows = await originalFindAllocations(args);
      allocationReads.push({ where: args.where, count: rows.length });
      return rows;
    };
    for (const query of [
      { limit: '1', offset: '0' },
      { limit: '1', offset: '1' },
      { limit: '2', offset: '2' },
      { limit: '2', offset: '20' },
      { limit: '2', offset: '0', creId: 'unassigned' },
      { limit: '2', offset: '0', search: vehicleIds[2] },
    ]) {
      const legacy = await run('false', query);
      const optimized = await run('true', query);
      assert.deepEqual(optimized.body, legacy.body, JSON.stringify(query));
      if (optimized.body.records.length) {
        assert.equal(optimized.reads.length, 1);
        assert.equal(optimized.reads[0].where.ccmId, ccmId);
        assert.ok(optimized.reads[0].count < legacy.reads[0].count);
      } else {
        assert.equal(optimized.reads.length, 0);
      }
    }
  } finally {
    prisma.allocation.findMany = originalFindAllocations;
    if (originalFlag === undefined) delete process.env.MASTER_CALL_LIST_SQL_ENABLED;
    else process.env.MASTER_CALL_LIST_SQL_ENABLED = originalFlag;
    invalidateCallListCache();
    await prisma.allocation.deleteMany({ where: { ccmId: { in: [ccmId, otherCcm] } } });
    await prisma.masterCallList.deleteMany({ where: { ccmId } });
    await prisma.vehicle.deleteMany({ where: { ccmId: { in: [ccmId, otherCcm] } } });
    await prisma.physicalVehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: [customerId, otherCustomer] } } });
    await prisma.$disconnect();
  }
});
