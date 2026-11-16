import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('same-owner allocation relink invalidates snapshots and fences an in-flight refresh', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { updateAllocation } = await import('../src/controllers/allocationController.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const { computeCrePerformanceMetrics } = await import('../src/controllers/callWorkflowController.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const team = `${id}-team`;
  const other = `${id}-other`;
  const cre = { id: `${id}-cre`, ccmId: team, name: 'Test CRE', role: 'CRE', password: 'test' };
  const actor = { id: `${id}-admin`, role: 'ADMIN' };
  const key = { creId: cre.id, ccmId: team, year: 2026, month: 11, viewer: 'CRE' };
  const otherKey = { ...key, creId: `${id}-other-cre`, ccmId: other };
  const where = { creId_ccmId_year_month_viewer: key };
  const now = new Date('2026-11-14T06:00:00Z');
  const metrics = async () => {
    const results = [];
    for (const enabled of ['false', 'true']) {
      process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = enabled;
      results.push(await computeCrePerformanceMetrics({ targetCre: cre, viewer: 'CRE', year: 2026, month: 11, now }));
    }
    return results;
  };
  let release;
  let pending;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.createMany({ data: [cre, { ...actor, name: 'Admin', password: 'test' }] });
    const customer = await prisma.customer.create({ data: { customerCode: id, fullName: 'Test', mobileNumber: '9000000000', ccmId: team } });
    const physical = await prisma.physicalVehicle.create({ data: { vin: id } });
    const vehicle = await prisma.vehicle.create({ data: {
      vin: id, physicalVehicleId: physical.id, customerId: customer.id, ccmId: team,
      saleDate: new Date('2020-01-01T00:00:00Z'),
    } });
    await prisma.workshopVisit.create({ data: {
      repairOrderNo: id, normalizedRepairOrderNo: id.toUpperCase(), physicalVehicleId: physical.id,
      vehicleId: vehicle.id, customerId: customer.id, ccmId: team,
      visitDate: new Date('2024-01-01T00:00:00Z'), importedDetails: { workType: 'Paid Service' },
    } });
    const entry = await prisma.masterCallList.create({ data: {
      vin: id, ccmId: team, ownerUserId: cre.id, vehicleId: null,
      customerName: 'Test', mobileNumber: '9000000000',
    } });
    const allocation = await prisma.allocation.create({ data: {
      vehicleId: vehicle.id, ccmId: team, creId: cre.id, serviceType: 'SERVICE', status: 'assigned',
    } });
    await prisma.crePerformanceSnapshot.createMany({ data: [
      { ...key, status: 'ok', callsThisMonth: 7, computedAt: now },
      { ...otherKey, status: 'ok', callsThisMonth: 9, computedAt: now },
    ] });
    const before = await metrics();
    const originalRevision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    pending = refreshSnapshot(key, { now, compute: async () => {
      entered();
      await gate;
      return { ...before[0], callsThisMonth: 99 };
    } });
    await ready;
    const response = {
      locals: {}, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await updateAllocation({ user: actor, params: { id: allocation.id }, body: { creId: cre.id } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).vehicleId, vehicle.id);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, originalRevision + 1n);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: otherKey } })).status, 'dirty');
    release();
    assert.deepEqual(await pending, { refreshed: false, reason: 'dirty' });
    pending = null;
    const snapshot = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where });
    assert.equal(snapshot.status, 'dirty');
    assert.equal(snapshot.callsThisMonth, 7);
    const after = await metrics();
    for (let i = 0; i < before.length; i++) {
      assert.notEqual(after[i].dueServicesCount, before[i].dueServicesCount);
    }
    assert.equal(after[0].dueServicesCount, after[1].dueServicesCount);
    await prisma.crePerformanceSnapshot.update({ where, data: { status: 'ok', dirtySince: null } });
    const revisionAfter = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision;
    const unchanged = { ...response, statusCode: 200 };
    await updateAllocation({ user: actor, params: { id: allocation.id }, body: { creId: cre.id } }, unchanged);
    assert.equal(unchanged.statusCode, 200);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, revisionAfter);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where })).status, 'ok');
  } finally {
    if (pending) { release(); await pending; }
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId: { in: [team, other] } } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${team}` } });
    await prisma.creCallDaily.deleteMany({ where: { userId: cre.id } });
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId: team } });
    await prisma.auditLog.deleteMany({ where: { userId: actor.id } });
    await prisma.allocation.deleteMany({ where: { ccmId: team } });
    await prisma.masterCallList.deleteMany({ where: { ccmId: team } });
    await prisma.workshopVisit.deleteMany({ where: { ccmId: team } });
    await prisma.vehicle.deleteMany({ where: { ccmId: team } });
    await prisma.customer.deleteMany({ where: { ccmId: team } });
    await prisma.physicalVehicle.deleteMany({ where: { vin: id } });
    await prisma.user.deleteMany({ where: { id: { in: [cre.id, actor.id] } } });
    await prisma.$disconnect();
  }
});

test('legacy monthly dataset attachment invalidates atomically and fences a refresh', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { getMonthlyCustomerData } = await import('../src/controllers/monthlyCustomerDataController.js');
  const { computeCrePerformanceMetrics } = await import('../src/controllers/callWorkflowController.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const team = `${id}-team`;
  const cre = { id: `${id}-cre`, ccmId: team, name: 'Test CRE', role: 'CRE', password: 'test' };
  const user = { id: `${id}-ccm`, name: 'Test CCM', role: 'CCM', ccmId: team };
  const key = { creId: cre.id, ccmId: team, year: 2026, month: 11, viewer: 'CRE' };
  const where = { creId_ccmId_year_month_viewer: key };
  const now = new Date('2026-11-14T06:00:00Z');
  const request = { user, params: { ccmId: team }, query: { year: '2026', month: '11' } };
  const response = () => ({
    locals: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  let release;
  let pending;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }, { scope: `ccm:${team}` }], skipDuplicates: true });
    await prisma.user.createMany({ data: [cre, { ...user, password: 'test' }] });
    const dataset = await prisma.monthlyCustomerDataset.create({ data: { ccmUserId: user.id, year: 2026, month: 11 } });
    const importedAt = new Date('2026-11-03T00:00:00Z');
    await prisma.monthlyCustomerDataImport.create({ data: {
      datasetId: dataset.id, fileName: 'legacy.csv', addedRows: 1, status: 'completed', createdAt: importedAt,
    } });
    await prisma.crePerformanceSnapshot.create({ data: { ...key, status: 'ok', callsThisMonth: 7, computedAt: now } });
    const calculate = () => computeCrePerformanceMetrics({ targetCre: cre, viewer: 'CRE', year: 2026, month: 11, now });
    const before = await calculate();
    assert.notEqual(before.cycleStartedAt.toISOString(), importedAt.toISOString());

    const originalTransaction = prisma.$transaction;
    prisma.$transaction = (callback, ...options) => originalTransaction.call(prisma, (transaction) => callback(new Proxy(transaction, {
      get(target, property) {
        if (property === 'performanceSnapshotRevision') return { upsert: async () => { throw new Error('injected invalidation failure'); } };
        return Reflect.get(target, property, target);
      },
    })), ...options);
    try {
      await assert.rejects(getMonthlyCustomerData(request, response()), /injected invalidation failure/);
    } finally {
      prisma.$transaction = originalTransaction;
    }
    assert.equal((await prisma.monthlyCustomerDataset.findUniqueOrThrow({ where: { id: dataset.id } })).ccmId, null);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where })).status, 'ok');

    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    pending = refreshSnapshot(key, { now, compute: async () => {
      entered();
      await gate;
      return { ...before, callsThisMonth: 99 };
    } });
    await ready;
    const revision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision;
    const result = response();
    await getMonthlyCustomerData(request, result);
    assert.equal(result.statusCode, 200);
    assert.equal((await prisma.monthlyCustomerDataset.findUniqueOrThrow({ where: { id: dataset.id } })).ccmId, team);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision, revision + 1n);
    assert.equal((await calculate()).cycleStartedAt.toISOString(), importedAt.toISOString());
    release();
    assert.deepEqual(await pending, { refreshed: false, reason: 'dirty' });
    pending = null;
    const snapshot = await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where });
    assert.equal(snapshot.status, 'dirty');
    assert.equal(snapshot.callsThisMonth, 7);
  } finally {
    if (pending) { release(); await pending; }
    await prisma.monthlyCustomerDataImport.deleteMany({ where: { dataset: { ccmUserId: user.id } } });
    await prisma.monthlyCustomerDataset.deleteMany({ where: { ccmUserId: user.id } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId: team } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${team}` } });
    await prisma.user.deleteMany({ where: { id: { in: [cre.id, user.id] } } });
    await prisma.$disconnect();
  }
});

test('monthly and repair-order relinks and rollback rebuild owned call aggregates', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { createMonthlyCustomerEntry } = await import('../src/controllers/monthlyCustomerDataController.js');
  const { importRepairOrders } = await import('../src/controllers/importController.js');
  const { createManualCallListEntry } = await import('../src/controllers/recordsController.js');
  const { rollbackImportBatch } = await import('../src/services/importRollbackService.js');
  const { deriveCreCallAggregateRows } = await import('../src/utils/creCallAggregates.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const team = `${id}-team`;
  const cre = `${id}-cre`;
  const user = { id: `${id}-ccm`, name: 'Test CCM', role: 'CCM', ccmId: team };
  const vins = ['1', '2', '3'].map((prefix) => `${prefix}HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`);
  const key = { creId: cre, ccmId: team, year: 2026, month: 11, viewer: 'CRE' };
  const response = () => ({
    locals: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const ownedCalls = async () => (await prisma.creCallDaily.findMany({
    where: { userId: cre, ccmId: team, scopeKind: 'OWNED' },
  })).reduce((sum, row) => sum + row.calls, 0);
  const liveCalls = async () => (await deriveCreCallAggregateRows(prisma, cre))
    .filter((row) => row.ccmId === team && row.scopeKind === 'OWNED')
    .reduce((sum, row) => sum + row.calls, 0);
  let batchId;
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
    await prisma.user.createMany({ data: [
      { ...user, password: 'test' },
      { id: cre, name: 'Test CRE', role: 'CRE', ccmId: team, password: 'test' },
    ] });
    for (const vin of vins) {
      const customer = await prisma.customer.create({ data: { customerCode: vin, fullName: 'Test', mobileNumber: '9000000000', ccmId: team } });
      const physical = await prisma.physicalVehicle.create({ data: { vin } });
      const vehicle = await prisma.vehicle.create({ data: { vin, physicalVehicleId: physical.id, customerId: customer.id, ccmId: team } });
      await prisma.masterCallList.create({ data: { vin, ccmId: team, ownerUserId: cre, customerName: 'Test', mobileNumber: '9000000000' } });
      await prisma.callLog.create({ data: {
        customerId: customer.id, vehicleId: vehicle.id, ccmId: team, createdById: cre,
        outcome: 'CONTACTED', createdAt: new Date('2026-11-01T00:00:00Z'),
      } });
    }
    await prisma.crePerformanceSnapshot.create({ data: { ...key, status: 'ok', callsThisMonth: 7, computedAt: new Date() } });
    assert.equal(await liveCalls(), 0);
    assert.equal(await ownedCalls(), 0);
    const monthly = response();
    await createMonthlyCustomerEntry({
      user, params: { ccmId: team }, query: { year: '2026', month: '11' },
      body: { vin: vins[0], customerName: 'Test', mobileNumber: '9000000000' },
    }, monthly);
    assert.equal(monthly.statusCode, 201);
    assert.equal(await liveCalls(), 1);
    assert.equal(await ownedCalls(), 1);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } })).status, 'dirty');

    await prisma.crePerformanceSnapshot.update({ where: { creId_ccmId_year_month_viewer: key }, data: { status: 'ok', dirtySince: null } });
    const manual = response();
    await createManualCallListEntry({ user, body: {
      roNumber: `${id}-manual`, vin: vins[2], customerName: 'Test', mobileNumber: '9000000000',
      visitDate: '2026-01-15', saleDate: '2025-01-15',
    } }, manual);
    assert.equal(manual.statusCode, 201);
    assert.equal(await liveCalls(), 2);
    assert.equal(await ownedCalls(), 2);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } })).status, 'dirty');

    await prisma.crePerformanceSnapshot.update({ where: { creId_ccmId_year_month_viewer: key }, data: { status: 'ok', dirtySince: null } });
    const imported = response();
    await importRepairOrders({ user, get: () => '', body: {
      fileName: 'relink.csv',
      content: [
        'RO Number,VIN,Customer Name,Mobile,Make,Model,Total Labor Cost,Total Parts Cost,Visit Date',
        `${id}-ro,${vins[1]},Test,9000000000,Hyundai,Test,100,50,2026-02-15`,
      ].join('\n'),
    } }, imported);
    assert.equal(imported.statusCode, 201);
    batchId = imported.body.batch.id;
    assert.equal(await liveCalls(), 3);
    assert.equal(await ownedCalls(), 3);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } })).status, 'dirty');

    await prisma.crePerformanceSnapshot.update({ where: { creId_ccmId_year_month_viewer: key }, data: { status: 'ok', dirtySince: null } });
    await rollbackImportBatch(batchId, user.id);
    assert.equal(await liveCalls(), 2);
    assert.equal(await ownedCalls(), 2);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: { creId_ccmId_year_month_viewer: key } })).status, 'dirty');
  } finally {
    if (batchId) {
      await prisma.importRowError.deleteMany({ where: { importBatchId: batchId } });
      await prisma.importBatch.deleteMany({ where: { id: batchId } });
    }
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.monthlyCustomerDataEntry.deleteMany({ where: { dataset: { ccmId: team } } });
    await prisma.monthlyCustomerDataset.deleteMany({ where: { ccmId: team } });
    await prisma.creCallDaily.deleteMany({ where: { ccmId: team } });
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId: team } });
    await prisma.callLog.deleteMany({ where: { ccmId: team } });
    await prisma.masterCallList.deleteMany({ where: { ccmId: team } });
    await prisma.workshopVisit.deleteMany({ where: { ccmId: team } });
    await prisma.vehicle.deleteMany({ where: { ccmId: team } });
    await prisma.customer.deleteMany({ where: { ccmId: team } });
    await prisma.physicalVehicle.deleteMany({ where: { vin: { in: vins } } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId: team } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: `ccm:${team}` } });
    await prisma.user.deleteMany({ where: { id: { in: [cre, user.id] } } });
    await prisma.$disconnect();
  }
});
