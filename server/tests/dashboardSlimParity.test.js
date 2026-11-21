import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDueCohorts, countOverdueRecords, creDueWhere, getDashboardSummary, isDashboardStreamedCallListEnabled, loadCallListRecords } from '../src/controllers/recordsController.js';
import { prisma } from '../src/config/prisma.js';
import { invalidateCallListCache } from '../src/utils/callListCache.js';
import { freeServiceCustomerIdsForMonth } from '../src/utils/serviceCalendar.js';
import { loadSnapshotCallListRecords, summarizeDashboardCallList } from '../src/utils/snapshotCallList.js';

test('streamed dashboard loader requires both experimental flags', () => {
  assert.equal(isDashboardStreamedCallListEnabled({}), false);
  assert.equal(isDashboardStreamedCallListEnabled({ DASHBOARD_STREAMED_CALL_LIST_ENABLED: 'true' }), false);
  assert.equal(isDashboardStreamedCallListEnabled({ DASHBOARD_SLIM_CALL_LIST_ENABLED: 'true' }), false);
  assert.equal(isDashboardStreamedCallListEnabled({ DASHBOARD_SLIM_CALL_LIST_ENABLED: 'true', DASHBOARD_STREAMED_CALL_LIST_ENABLED: 'yes' }), false);
  assert.equal(isDashboardStreamedCallListEnabled({ DASHBOARD_SLIM_CALL_LIST_ENABLED: '1', DASHBOARD_STREAMED_CALL_LIST_ENABLED: 'true' }), true);
});

test('slim dashboard inputs preserve cohort and workload counts on assigned, allocated and duplicate records', async () => {
  const now = new Date('2026-11-14T06:00:00Z');
  const user = { id: 'cre-a', ccmId: 'team-a', role: 'CRE', freeServiceEnabled: true };
  const visit = (id, physicalVehicleId, date, workType, saleDate) => ({
    id,
    physicalVehicleId,
    visitDate: date ? new Date(date) : null,
    importedDetails: { workType, ...(saleDate ? { saleDate } : {}) },
  });
  const history = {
    'physical-paid': [visit('paid', 'physical-paid', '2025-11-12T00:00:00Z', 'Paid Service')],
    'physical-six': [visit('six', 'physical-six', '2026-05-12T00:00:00Z', 'Paid Service')],
    'physical-free': [visit('free', 'physical-free', '2026-09-10T00:00:00Z', 'Free Service', '2026-09-20')],
  };
  const vehicle = (id, customerId, saleDate) => ({
    id, customerId, physicalVehicleId: `physical-${id}`, saleDate: saleDate ? new Date(saleDate) : null,
    physicalVehicle: { workshopVisits: history[`physical-${id}`] },
    allocations: [], monthlyDataEntries: [], appointments: [], customer: { appointments: [] },
  });
  const row = (id, vin, ownerUserId, linkedVehicle, createdAt) => ({
    id, vin, ownerUserId, vehicle: linkedVehicle, ccmId: user.ccmId,
    createdAt: new Date(createdAt), customerName: 'Customer', mobileNumber: '000',
  });
  const rows = [
    row('paid', 'vin-paid', user.id, vehicle('paid', 'customer-one', '2023-01-01'), '2026-11-05'),
    row('duplicate', 'vin-paid', null, vehicle('paid', 'customer-one', '2023-01-01'), '2026-11-04'),
    row('six', 'vin-six', null, vehicle('six', 'customer-one', '2023-01-01'), '2026-11-03'),
    row('free', 'vin-free', user.id, vehicle('free', 'customer-two', null), '2026-11-02'),
    row('unlinked', 'vin-unlinked', user.id, null, '2026-11-01'),
  ];
  const where = creDueWhere(user.id, user.ccmId);
  const db = {
    masterCallList: {
      findMany: async (args) => {
        assert.deepEqual(args.where, where);
        return [...rows];
      },
    },
    workshopVisit: {
      findMany: async ({ where: visitWhere }) => {
        assert.equal(visitWhere.physicalVehicle.is.vehicles.some.ccmId, user.ccmId);
        return visitWhere.physicalVehicleId.in.flatMap((id) => history[id] || []);
      },
    },
    user: { findMany: async () => [] },
  };
  const legacy = await loadCallListRecords(where, now, user, { db });
  const slim = await loadSnapshotCallListRecords(where, now, user, { db });
  const metrics = (records) => {
    const cohorts = classifyDueCohorts(records, now);
    const free = freeServiceCustomerIdsForMonth(records, 2026, 11, now);
    return {
      oneYear: cohorts.oneYear.map((item) => item.id),
      sixMonth: cohorts.sixMonth.map((item) => item.id),
      free: [...free].sort(),
      workload: new Set([...cohorts.oneYear, ...cohorts.sixMonth].map((item) => item.customerId).concat([...free]).filter(Boolean)).size,
      overdue: countOverdueRecords(records, now),
    };
  };
  assert.deepEqual(metrics(slim), metrics(legacy));
  assert.deepEqual(metrics(slim).oneYear, ['paid']);
  assert.deepEqual(metrics(slim).sixMonth, ['six']);
  assert.deepEqual(metrics(slim).free, ['customer-two']);
  assert.equal(metrics(slim).workload, 2);
  assert.equal(legacy.length, 4);
  assert.deepEqual(await summarizeDashboardCallList(where, now, user, {
    year: 2026, month: 11, includeFreeService: true, db,
  }), { oneYear: 1, sixMonth: 1, freeService: 1, assignedWorkload: 2, dueServicesCount: metrics(legacy).overdue });
});

test('streamed dashboard summaries batch shared histories and match the full slim calculation', async () => {
  const now = new Date('2026-11-14T06:00:00Z');
  const user = { id: 'cre', ccmId: 'team', role: 'CRE' };
  const rows = Array.from({ length: 1002 }, (_, index) => ({
    id: `row-${index}`, vin: `vin-${index}`, ccmId: 'team', ownerUserId: 'cre',
    createdAt: new Date(2000000 - index),
    vehicle: { physicalVehicleId: `physical-${index === 1001 ? 0 : index}`, customerId: `customer-${index % 37}`,
      saleDate: new Date('2026-09-20T00:00:00Z') },
  }));
  rows.push({ id: 'unlinked', vin: 'unlinked', ccmId: 'team', ownerUserId: 'cre', createdAt: new Date(0), vehicle: null });
  const reads = [];
  const db = {
    masterCallList: { findMany: async ({ where, take }) => {
      const cursor = where.AND?.[1]?.OR?.[0]?.createdAt?.lt;
      const start = cursor ? rows.findIndex((row) => row.createdAt < cursor) : 0;
      return rows.slice(start < 0 ? rows.length : start, (start < 0 ? rows.length : start) + take);
    } },
    workshopVisit: { findMany: async ({ where }) => {
      const ids = where.physicalVehicleId.in;
      reads.push(ids);
      assert.equal(where.physicalVehicle.is.vehicles.some.ccmId, 'team');
      return ids.filter((id) => Number(id.split('-')[1]) % 2 === 0)
        .map((id) => ({ id: `visit-${id}`, physicalVehicleId: id, visitDate: new Date('2025-11-01T00:00:00Z'), importedDetails: { workType: 'Paid Service' } }));
    } },
  };
  const where = { ccmId: 'team' };
  const full = await loadSnapshotCallListRecords(where, now, user, { db });
  const cohorts = classifyDueCohorts(full, now);
  const free = freeServiceCustomerIdsForMonth(full, 2026, 11, now);
  const workload = new Set([...cohorts.oneYear, ...cohorts.sixMonth].map((record) => record.customerId).concat([...free]).filter(Boolean));
  reads.length = 0;
  assert.deepEqual(await summarizeDashboardCallList(where, now, user, {
    year: 2026, month: 11, includeFreeService: true, db,
  }), {
    oneYear: cohorts.oneYear.length, sixMonth: cohorts.sixMonth.length,
    freeService: free.size, assignedWorkload: workload.size, dueServicesCount: countOverdueRecords(full, now),
  });
  assert.deepEqual(reads.map((ids) => ids.length), [500, 500, 1]);
  assert.equal(new Set(reads.flat()).size, 1001);
  reads.length = 0;
  const withoutFree = await summarizeDashboardCallList(where, now, user, {
    year: 2026, month: 11, includeFreeService: false, db,
  });
  assert.equal(withoutFree.freeService, null);
  assert.equal(withoutFree.assignedWorkload, new Set([...cohorts.oneYear, ...cohorts.sixMonth].map((record) => record.customerId).filter(Boolean)).size);
});

test('streamed dashboard summary fails when a later history batch fails', async () => {
  const now = new Date();
  const failure = new Error('history read failed');
  const rows = Array.from({ length: 501 }, (_, i) => ({
    id: `row-${i}`, vin: `vin-${i}`, ccmId: 'team', ownerUserId: 'cre',
    createdAt: new Date(2000000 - i),
    vehicle: { physicalVehicleId: `vehicle-${i}`, customerId: `customer-${i}` },
  }));
  let queries = 0;
  const db = {
    masterCallList: { findMany: async ({ where }) => where.AND ? rows.slice(500) : rows.slice(0, 500) },
    workshopVisit: { findMany: async () => { if (++queries === 2) throw failure; return []; } },
  };
  await assert.rejects(summarizeDashboardCallList({}, now, { role: 'CCM', ccmId: 'team' }, {
    year: 2026, month: 11, includeFreeService: true, db,
  }), (error) => error === failure);
  assert.equal(queries, 2);
});

test('complete CRE dashboard response is unchanged with the slim loader across service permissions', async () => {
  const now = new Date();
  const visitDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  const visit = { id: 'visit', physicalVehicleId: 'physical', visitDate, importedDetails: { workType: 'Paid Service' } };
  const record = {
    id: 'master', ccmId: 'team-a', ownerUserId: 'cre-a', vin: 'vin',
    customerName: 'Customer', mobileNumber: '000', createdAt: new Date(2020, 0, 1),
    vehicle: {
      id: 'vehicle', customerId: 'customer', physicalVehicleId: 'physical', saleDate: new Date(2019, 0, 1),
      physicalVehicle: { workshopVisits: [visit] }, allocations: [], monthlyDataEntries: [],
      appointments: [], customer: { appointments: [] },
    },
  };
  const eligibilityQueries = [];
  const followUpCounts = [];
  const followUpLists = [];
  const methods = [
    [prisma.customer, 'count', async () => 1],
    [prisma.vehicle, 'count', async () => 1],
    [prisma.vehicle, 'findMany', async () => []],
    [prisma.callLog, 'count', async () => 0],
    [prisma.callLog, 'groupBy', async () => []],
    [prisma.appointment, 'count', async () => 0],
    [prisma.appointment, 'findMany', async () => []],
    [prisma.followUp, 'count', async ({ where }) => { followUpCounts.push(where); return 0; }],
    [prisma.followUp, 'findMany', async ({ where, select }) => {
      if (select) {
        eligibilityQueries.push(where);
        return [{ id: 'ineligible', vehicle: null, milestone: null }];
      }
      followUpLists.push(where);
      return [];
    }],
    [prisma.importBatch, 'aggregate', async () => ({ _sum: { totalRows: null, flaggedRows: null } })],
    [prisma.vINConflictReview, 'count', async () => 0],
    [prisma.allocation, 'count', async () => 0],
    [prisma.masterCallList, 'findMany', async () => [record]],
    [prisma.workshopVisit, 'findMany', async () => [visit]],
    [prisma.user, 'findMany', async () => []],
  ];
  const originals = methods.map(([object, method]) => object[method]);
  for (const [object, method, implementation] of methods) object[method] = implementation;
  const previous = process.env.DASHBOARD_SLIM_CALL_LIST_ENABLED;
  const previousStreamed = process.env.DASHBOARD_STREAMED_CALL_LIST_ENABLED;
  const user = { id: 'cre-a', ccmId: 'team-a', role: 'CRE', freeServiceEnabled: true, warrantyEnabled: true };
  const read = async (enabled, streamed = false) => {
    process.env.DASHBOARD_SLIM_CALL_LIST_ENABLED = String(enabled);
    process.env.DASHBOARD_STREAMED_CALL_LIST_ENABLED = String(streamed);
    invalidateCallListCache();
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getDashboardSummary({ user, query: {} }, response);
    assert.equal(response.statusCode, 200);
    return response.body;
  };
  try {
    for (const freeServiceEnabled of [false, true]) {
      for (const warrantyEnabled of [false, true]) {
        user.freeServiceEnabled = freeServiceEnabled;
        user.warrantyEnabled = warrantyEnabled;
        const eligibilityBefore = eligibilityQueries.length;
        const countBefore = followUpCounts.length;
        const legacy = await read(false);
        const slim = await read(true);
        const streamed = await read(true, true);
        assert.deepEqual(slim, legacy);
        assert.deepEqual(streamed, legacy);
        assert.equal(slim.cre.categoryCounts.oneYear, 1);
        assert.equal(slim.cre.assignedWorkload, 1);
        assert.equal(slim.cre.categoryCounts.freeService === null, !freeServiceEnabled);
        assert.equal(slim.cre.categoryCounts.missedWarranty === null, !warrantyEnabled);
        assert.equal(eligibilityQueries.length - eligibilityBefore, freeServiceEnabled ? 3 : 0);
        for (let i = countBefore; i < countBefore + 3; i += 1) {
          assert.deepEqual(followUpLists[i], followUpCounts[i]);
          assert.equal(JSON.stringify(followUpLists[i]).includes('ineligible'), freeServiceEnabled);
        }
        for (const where of eligibilityQueries.slice(eligibilityBefore)) {
          assert.equal(where.ccmId, user.ccmId);
          assert.equal(where.source, 'FREE_SERVICE');
        }
      }
    }
  } finally {
    methods.forEach(([object, method], index) => { object[method] = originals[index]; });
    if (previous === undefined) delete process.env.DASHBOARD_SLIM_CALL_LIST_ENABLED;
    else process.env.DASHBOARD_SLIM_CALL_LIST_ENABLED = previous;
    if (previousStreamed === undefined) delete process.env.DASHBOARD_STREAMED_CALL_LIST_ENABLED;
    else process.env.DASHBOARD_STREAMED_CALL_LIST_ENABLED = previousStreamed;
    invalidateCallListCache();
  }
});
