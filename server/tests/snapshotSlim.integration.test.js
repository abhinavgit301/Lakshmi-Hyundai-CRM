import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;
const scaleRun = process.env.SNAPSHOT_SCALE_TEST === 'true';

test('slim snapshot matches the existing calculation on a multi-team PostgreSQL fixture', { skip: !databaseUrl && !scaleRun, timeout: scaleRun ? 1800000 : 120000 }, async () => {
  assert.ok(databaseUrl, 'SNAPSHOT_INTEGRATION_DATABASE_URL is required for a scale run');
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  if (scaleRun) assert.equal(url.pathname, '/snapshot_test_phase5_scale');
  for (const [key, value] of url.searchParams) {
    assert.ok(key === 'schema' && value === 'public', 'unexpected database connection option');
  }
  process.env.DATABASE_URL = databaseUrl;
  const originalQuery = pg.Client.prototype.query;
  let queries = 0;
  pg.Client.prototype.query = function (...args) {
    queries += 1;
    return originalQuery.apply(this, args);
  };
  const { prisma } = await import('../src/config/prisma.js');
  const { computeCrePerformanceMetrics, computeFreeServiceCrePerformanceMetrics } = await import('../src/controllers/callWorkflowController.js');
  const { loadCallListRecords, creDueWhere, classifyDueCohorts, getDashboardSummary } = await import('../src/controllers/recordsController.js');
  const { invalidateCallListCache } = await import('../src/utils/callListCache.js');
  const { createSnapshotLifecycleResolver, loadSnapshotCallListRecords } = await import('../src/utils/snapshotCallList.js');
  const { freeServiceCustomerIdsForMonth, getServiceLifecycle } = await import('../src/utils/serviceCalendar.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const prefix = randomUUID();
  const teams = [`${prefix}-a`, `${prefix}-b`];
  const cres = teams.map((ccmId, i) => ({
    id: `${prefix}-cre-${i}`, name: `CRE ${i}`, password: 'test', role: 'CRE', ccmId,
    freeServiceEnabled: i === 0, warrantyEnabled: i === 0,
  }));
  const outsider = { id: `${prefix}-outsider`, name: 'Other CRE', password: 'test', role: 'CRE', ccmId: teams[0] };
  const freeCre = { id: `${prefix}-free`, name: 'Free CRE', password: 'test', role: 'FREE_SERVICE_CRE', ccmId: teams[0] };
  const now = new Date('2026-11-14T06:00:00Z');
  const count = scaleRun ? 20658 : 1200;
  const customers = [];
  const customerIds = new Set();
  const physicalVehicles = [];
  const vehicles = [];
  const masters = [];
  const visits = [];
  const allocations = [];
  for (let i = 0; i < count; i += 1) {
    const team = i % 2;
    const id = `${prefix}-${i}`;
    const customerId = `${prefix}-customer-${team}-${Math.floor(i / 4)}`;
    if (!customerIds.has(customerId)) {
      customers.push({ id: customerId, customerCode: customerId, fullName: 'Synthetic customer', ccmId: teams[team] });
      customerIds.add(customerId);
    }
    physicalVehicles.push({ id, vin: id });
    vehicles.push({
      id, vin: id, customerId, physicalVehicleId: id, ccmId: teams[team],
      saleDate: i % 7 === 0 ? null : new Date(i % 4 === 0 ? '2026-09-10T00:00:00Z' : '2023-10-14T00:00:00Z'),
    });
    masters.push({
      id, vin: id, ccmId: teams[team], vehicleId: id, ownerUserId: i === 2 ? null : cres[team].id,
      customerName: 'Synthetic customer', mobileNumber: '0000000000',
      createdAt: new Date(1700000000000 + i * 1000),
    });
    if (i % 25 === 0) {
      masters.push({
        ...masters.at(-1), id: `${id}-duplicate`, ownerUserId: null,
        createdAt: new Date(1600000000000 + i * 1000),
      });
      allocations.push({ vehicleId: id, ccmId: teams[team], creId: cres[team].id, serviceType: 'SERVICE' });
    }
    if (i === 2) allocations.push({ vehicleId: id, ccmId: teams[team], creId: cres[team].id, serviceType: 'SERVICE' });
    for (let j = 0; j < (i % 13 === 0 ? 20 : 5); j += 1) {
      const workType = ['Paid Service', 'Free Service', 'Unknown', 'Periodic Service', 'Running Repair'][i % 5];
      visits.push({
        id: `${id}-visit-${j}`, repairOrderNo: `${id}-${j}`, normalizedRepairOrderNo: `${id}-${j}`,
        ccmId: teams[team], customerId, vehicleId: id, physicalVehicleId: id,
        visitDate: i === 7 && j === 0 ? null
          : i === 7 && j === 2 ? new Date(Date.UTC(2026, 8, 14))
            : new Date(Date.UTC(2025 + (j % 2), (i + j) % 12, 14)),
        importedDetails: { workType, saleDate: i === 7 && j === 1 ? 'invalid' : '2023-10-14', filler: 'x'.repeat(100) },
      });
    }
  }
  const sharedId = `${prefix}-shared`;
  const sharedCustomer = customers.find((customer) => customer.ccmId === teams[1]).id;
  vehicles.push({
    id: sharedId, vin: `${prefix}-0`, customerId: sharedCustomer,
    physicalVehicleId: `${prefix}-0`, ccmId: teams[1], saleDate: new Date('2023-10-14T00:00:00Z'),
  });
  masters.push({
    id: sharedId, vin: `${prefix}-0`, ccmId: teams[1], vehicleId: sharedId, ownerUserId: cres[1].id,
    customerName: 'Synthetic shared vehicle', mobileNumber: '0000000000',
    createdAt: new Date(1700000000000),
  });
  visits.push({
    id: `${sharedId}-visit`, repairOrderNo: sharedId, normalizedRepairOrderNo: sharedId,
    ccmId: teams[1], customerId: sharedCustomer, vehicleId: sharedId, physicalVehicleId: `${prefix}-0`,
    visitDate: new Date('2026-05-01T00:00:00Z'), importedDetails: { workType: 'Paid Service' },
  });
  const outsideId = `${prefix}-outside`;
  const outsideCustomer = customers.find((customer) => customer.ccmId === teams[0]).id;
  physicalVehicles.push({ id: outsideId, vin: outsideId });
  vehicles.push({ id: outsideId, vin: outsideId, customerId: outsideCustomer, physicalVehicleId: outsideId, ccmId: teams[0] });
  masters.push({
    id: outsideId, vin: outsideId, ccmId: teams[0], vehicleId: outsideId, ownerUserId: outsider.id,
    customerName: 'Synthetic other CRE', mobileNumber: '0000000000',
  });
  try {
    await prisma.user.createMany({ data: [...cres, outsider, freeCre] });
    const insertBatches = async (model, rows) => {
      for (let i = 0; i < rows.length; i += 500) await model.createMany({ data: rows.slice(i, i + 500) });
    };
    await insertBatches(prisma.customer, customers);
    await insertBatches(prisma.physicalVehicle, physicalVehicles);
    await insertBatches(prisma.vehicle, vehicles);
    await insertBatches(prisma.allocation, allocations);
    await insertBatches(prisma.masterCallList, masters);
    await insertBatches(prisma.workshopVisit, visits);
    await prisma.callLog.createMany({ data: cres.map((cre, i) => ({
      customerId: customers.find((customer) => customer.ccmId === cre.ccmId).id,
      vehicleId: vehicles.find((vehicle) => vehicle.ccmId === cre.ccmId).id,
      ccmId: cre.ccmId, createdById: cre.id, assignedToId: cre.id, outcome: i ? 'CONTACTED' : 'APPOINTMENT_SET',
      callSource: 'SERVICE', createdAt: now,
    })) });
    await prisma.callLog.create({ data: {
      customerId: outsideCustomer, ccmId: teams[0], createdById: freeCre.id,
      outcome: 'CONTACTED', callSource: 'FREE_SERVICE', createdAt: now,
    } });
    await prisma.callLog.createMany({ data: ['2026-10-31T18:29:59.999Z', '2026-10-31T18:30:00.000Z'].map((createdAt) => ({
      customerId: outsideCustomer, vehicleId: `${prefix}-0`, ccmId: teams[0],
      createdById: cres[0].id, assignedToId: cres[0].id, outcome: 'CONTACTED',
      callSource: 'SERVICE', createdAt: new Date(createdAt),
    })) });
    await prisma.followUp.createMany({ data: cres.map((cre) => ({
      customerId: customers.find((customer) => customer.ccmId === cre.ccmId).id,
      vehicleId: vehicles.find((vehicle) => vehicle.ccmId === cre.ccmId).id,
      ccmId: cre.ccmId, creId: cre.id, source: 'SERVICE', followUpAt: now, category: 'follow-up',
    })) });
    await prisma.appointment.createMany({ data: cres.map((cre) => ({
      customerId: customers.find((customer) => customer.ccmId === cre.ccmId).id,
      vehicleId: vehicles.find((vehicle) => vehicle.ccmId === cre.ccmId).id,
      ccmId: cre.ccmId, assigneeId: cre.id, createdById: cre.id,
      customerName: 'Synthetic customer', vehicleName: 'Synthetic vehicle', scheduledAt: now,
    })) });

    const measure = async (label, work) => {
      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const q = queries;
      const start = performance.now();
      const result = await work();
      const elapsedMs = Math.round(performance.now() - start);
      console.log(JSON.stringify({ label, elapsedMs, queries: queries - q, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore }));
      return result;
    };
    for (const [i, cre] of cres.entries()) {
      const user = { ...cre, role: 'CRE' };
      const where = creDueWhere(cre.id, cre.ccmId);
      const legacy = await measure(`team-${i}-legacy-loader`, () => loadCallListRecords(where, now, user));
      const events = [];
      const slim = await measure(`team-${i}-slim-loader`, () => loadSnapshotCallListRecords(where, now, user, {
        snapshotTrace: { emit: (event, details) => events.push({ event, ...details }) },
      }));
      assert.equal(slim.length, legacy.length);
      assert.equal(slim.length, count / 2 + i);
      const projection = (records) => records.map((r) => ({
        id: r.id, customerId: r.customerId, saleDate: r.saleDate, dueDate: r.dueDate,
        visits: r.workshopVisits.map((v) => ({ visitDate: v.visitDate, importedDetails: v.importedDetails })),
      })).sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(projection(slim), projection(legacy));
      const loaded = events.find((event) => event.event === 'call_list_loaded');
      const expectedRows = masters.filter((master) => master.ccmId === cre.ccmId && master.id !== outsideId).length;
      assert.equal(loaded.rows, expectedRows);
      if (scaleRun) assert.equal(loaded.rows, 10743);
      assert.ok(events.some((event) => event.event === 'call_list_progress' && event.pages === Math.floor(expectedRows / 500) + 1));
      assert.ok(!slim.some((record) => record.id === outsideId));
      if (i === 0) assert.ok(slim.some((record) => record.id === `${prefix}-2` && record.assigneeId === null));
      console.log(JSON.stringify({ label: `team-${i}-records`, inputRows: loaded.rows, canonicalRecords: loaded.canonicalRecords,
        slimVisits: loaded.visits, legacyRetainedVisits: legacy.reduce((sum, record) => sum + record.workshopVisits.length, 0) }));

      const readDashboard = async (enabled, streamed = false) => {
        process.env.DASHBOARD_SLIM_CALL_LIST_ENABLED = String(enabled);
        process.env.DASHBOARD_STREAMED_CALL_LIST_ENABLED = String(streamed);
        invalidateCallListCache();
        const response = {
          statusCode: 200,
          status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; return this; },
        };
        await getDashboardSummary({ user: cre, query: {} }, response);
        assert.equal(response.statusCode, 200);
        return response.body;
      };
      assert.deepEqual(
        await measure(`team-${i}-slim-dashboard`, () => readDashboard(true)),
        await measure(`team-${i}-legacy-dashboard`, () => readDashboard(false)),
      );
      assert.deepEqual(
        await measure(`team-${i}-streamed-dashboard`, () => readDashboard(true, true)),
        await measure(`team-${i}-legacy-dashboard-repeat`, () => readDashboard(false)),
      );

      let legacyLifecycleCalls = 0;
      const calculateLegacy = (record, date) => { legacyLifecycleCalls += 1; return getServiceLifecycle(record, date); };
      const legacyCohorts = classifyDueCohorts(slim, now, calculateLegacy);
      const legacyFree = freeServiceCustomerIdsForMonth(slim, 2026, 11, now, calculateLegacy);
      let slimLifecycleCalls = 0;
      const resolve = createSnapshotLifecycleResolver((record, date) => {
        slimLifecycleCalls += 1;
        return getServiceLifecycle(record, date);
      });
      assert.deepEqual(classifyDueCohorts(slim, now, resolve), legacyCohorts);
      assert.deepEqual(freeServiceCustomerIdsForMonth(slim, 2026, 11, now, resolve), legacyFree);
      assert.ok(slimLifecycleCalls < legacyLifecycleCalls);
      console.log(JSON.stringify({ label: `team-${i}-classification-lifecycle-calls`, legacy: legacyLifecycleCalls, slim: slimLifecycleCalls }));

      for (const viewer of ['CRE', 'CCM']) {
        for (const month of [10, 11]) {
          process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = 'false';
          const before = await measure(`team-${i}-${viewer}-${month}-legacy-snapshot`, () => computeCrePerformanceMetrics({ targetCre: cre, viewer, year: 2026, month, now }));
          process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = 'true';
          const after = await measure(`team-${i}-${viewer}-${month}-slim-snapshot`, () => computeCrePerformanceMetrics({ targetCre: cre, viewer, year: 2026, month, now }));
          assert.deepEqual(after, before);
          process.env.PERFORMANCE_SNAPSHOT_STREAMED_CALL_LIST_ENABLED = 'true';
          const streamed = await measure(`team-${i}-${viewer}-${month}-streamed-snapshot`, () => computeCrePerformanceMetrics({ targetCre: cre, viewer, year: 2026, month, now }));
          assert.deepEqual(streamed, before);
          const streamedConsistent = await prisma.$transaction(async (db) => {
            await db.$executeRaw`SET TRANSACTION READ ONLY`;
            const finish = await computeCrePerformanceMetrics({ targetCre: cre, viewer, year: 2026, month, now, db, deferClassification: true });
            return finish;
          }, { isolationLevel: 'RepeatableRead', timeout: 60000, maxWait: 2000 });
          assert.deepEqual(await streamedConsistent(), before);
          delete process.env.PERFORMANCE_SNAPSHOT_STREAMED_CALL_LIST_ENABLED;
          for (const slimEnabled of ['false', 'true']) {
            process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = slimEnabled;
            const consistent = await measure(`team-${i}-${viewer}-${month}-${slimEnabled === 'true' ? 'slim' : 'legacy'}-repeatable-read`, () => prisma.$transaction(async (db) => {
              await db.$executeRaw`SET TRANSACTION READ ONLY`;
              return computeCrePerformanceMetrics({ targetCre: cre, viewer, year: 2026, month, now, db });
            }, { isolationLevel: 'RepeatableRead', timeout: 60000, maxWait: 2000 }));
            assert.deepEqual(consistent, before);
          }
          assert.ok(after.pendingFollowUps > 0);
          assert.ok(after.details.lifetimeAppointments > 0);
          if (i === 0) assert.equal(after.callsThisMonth, month === 10 ? 1 : 2);
          if (i === 0 && viewer === 'CCM' && month === 11) assert.ok(after.details.assignedBreakdown.freeService > 0);
        }
      }
    }
    process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = 'false';
    const freeBefore = await computeFreeServiceCrePerformanceMetrics({ targetCre: freeCre, year: 2026, month: 11, now });
    assert.equal(freeBefore.callsThisMonth, 1);
    process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = 'true';
    assert.deepEqual(await computeFreeServiceCrePerformanceMetrics({ targetCre: freeCre, year: 2026, month: 11, now }), freeBefore);
    {
      process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED = 'true';
      await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }], skipDuplicates: true });
      const key = { creId: cres[0].id, ccmId: cres[0].ccmId, year: 2026, month: 11, viewer: 'CRE' };
      let legacyMetrics;
      for (const mode of ['legacy', 'slim', 'streamed']) {
        process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED = String(mode !== 'legacy');
        process.env.PERFORMANCE_SNAPSHOT_STREAMED_CALL_LIST_ENABLED = String(mode === 'streamed');
        const result = await measure(`team-0-${mode}-fenced-refresh`, () => refreshSnapshot(key, { now }));
        assert.deepEqual(result, { refreshed: true });
        const snapshot = await prisma.crePerformanceSnapshot.findUniqueOrThrow({
          where: { creId_ccmId_year_month_viewer: key },
        });
        assert.equal(snapshot.status, 'ok');
        const { callsThisMonth, assignedCustomerCount, pendingFollowUps, dueServicesCount, missedWarrantyCount, details, cycleStartedAt, asOf } = snapshot;
        const metrics = { callsThisMonth, assignedCustomerCount, pendingFollowUps, dueServicesCount, missedWarrantyCount, details, cycleStartedAt, asOf };
        if (legacyMetrics) assert.deepEqual(metrics, legacyMetrics);
        else legacyMetrics = metrics;
      }
    }
  } finally {
    pg.Client.prototype.query = originalQuery;
    delete process.env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED;
    delete process.env.PERFORMANCE_SNAPSHOT_STREAMED_CALL_LIST_ENABLED;
    delete process.env.DASHBOARD_SLIM_CALL_LIST_ENABLED;
    delete process.env.DASHBOARD_STREAMED_CALL_LIST_ENABLED;
    delete process.env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED;
    await prisma.$disconnect();
  }
});
