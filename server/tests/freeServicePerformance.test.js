import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import {
  computeFreeServiceCrePerformanceMetrics,
  getFreeServicePerformanceSummary,
} from '../src/controllers/callWorkflowController.js';
import {
  getSnapshot,
  refreshSnapshot,
  seedCurrentMonthSnapshots,
  snapshotWhere,
} from '../src/services/performanceSnapshotService.js';
import { workshopMonthOf, workshopMonthRange, zonedDateKey } from '../src/utils/workshopTime.js';

const CRE_ID = 'free-service-cre';
const CCM_ID = 'free-service-ccm';

function installFreeServiceWorld(t, {
  enabled,
  snapshotRow = null,
  now = new Date(),
  creId = CRE_ID,
  ccmId = CCM_ID,
  dateKey = zonedDateKey(now),
} = {}) {
  const previousEnabled = process.env.PERFORMANCE_AGGREGATES_ENABLED;
  process.env.PERFORMANCE_AGGREGATES_ENABLED = String(enabled);
  t.after(() => {
    if (previousEnabled === undefined) delete process.env.PERFORMANCE_AGGREGATES_ENABLED;
    else process.env.PERFORMANCE_AGGREGATES_ENABLED = previousEnabled;
  });

  const [year, month] = dateKey.split('-').map(Number);
  const { start, end } = workshopMonthRange(year, month);
  const activityAt = new Date(`${dateKey}T12:00:00.000Z`);
  const calls = [
    {
      id: 'free-service-call-1',
      createdById: creId,
      ccmId,
      callSource: 'FREE_SERVICE',
      outcome: 'CONTACTED',
      createdAt: new Date(Math.max(start.getTime(), activityAt.getTime() - 3 * 86400000)),
      customerCcmId: ccmId,
      vehicleCcmId: ccmId,
    },
    {
      id: 'free-service-call-2',
      createdById: creId,
      ccmId,
      callSource: 'FREE_SERVICE',
      outcome: 'NO_RESPONSE',
      createdAt: new Date(Math.max(start.getTime(), activityAt.getTime() - 2 * 86400000)),
      customerCcmId: ccmId,
      vehicleCcmId: ccmId,
    },
    {
      id: 'free-service-call-today',
      createdById: creId,
      ccmId,
      callSource: 'FREE_SERVICE',
      outcome: 'CONTACTED',
      createdAt: activityAt,
      customerCcmId: ccmId,
      vehicleCcmId: ccmId,
    },
    {
      id: 'other-ccm-call',
      createdById: creId,
      ccmId: 'other-ccm',
      callSource: 'FREE_SERVICE',
      outcome: 'CONTACTED',
      createdAt: new Date(Math.max(start.getTime(), activityAt.getTime() - 1 * 86400000)),
      customerCcmId: 'other-ccm',
      vehicleCcmId: 'other-ccm',
    },
    {
      id: 'other-source-call',
      createdById: creId,
      ccmId,
      callSource: 'SERVICE',
      outcome: 'CONTACTED',
      createdAt: new Date(Math.max(start.getTime(), activityAt.getTime() - 1 * 86400000)),
      customerCcmId: ccmId,
      vehicleCcmId: ccmId,
    },
  ].filter((call) => call.createdAt < end);
  const dailyRows = calls
    .filter((call) => call.ccmId === ccmId && call.callSource === 'FREE_SERVICE')
    .reduce((rows, call) => {
      const date = zonedDateKey(call.createdAt);
      const row = rows.get(date) || { date, callsMade: 0, callsPickedUp: 0 };
      row.callsMade += 1;
      if (call.outcome !== 'NO_RESPONSE') row.callsPickedUp += 1;
      rows.set(date, row);
      return rows;
    }, new Map());
  const counterRows = [...dailyRows.values()].map((row) => ({
    userId: creId,
    ccmId,
    scopeKind: 'TEAM',
    callSource: 'FREE_SERVICE',
    workshopDate: new Date(`${row.date}T00:00:00.000Z`),
    calls: row.callsMade,
    answeredCalls: row.callsPickedUp,
  }));
  const freeServiceUser = { id: creId, name: 'Free-Service CRE', ccmId };
  const expectedSnapshotKey = {
    creId, ccmId, year, month, viewer: 'FREE_SERVICE_CRE',
  };
  const originalMethods = [];
  const replace = (delegateName, method, implementation) => {
    const delegate = prisma[delegateName];
    originalMethods.push({ delegate, method, value: delegate[method] });
    delegate[method] = implementation;
  };
  const matchesCall = (call, where) => (
    (!where.createdById
      || (typeof where.createdById === 'string'
        ? call.createdById === where.createdById
        : where.createdById.in?.includes(call.createdById)))
    && (!where.ccmId || call.ccmId === where.ccmId)
    && (!where.callSource
      || (typeof where.callSource === 'string'
        ? call.callSource === where.callSource
        : where.callSource.in?.includes(call.callSource)))
    && (!where.createdAt?.gte || call.createdAt >= where.createdAt.gte)
    && (!where.createdAt?.lt || call.createdAt < where.createdAt.lt)
    && (!where.OR || where.OR.some((branch) => (
      (branch.vehicleId === null && call.vehicleCcmId === branch.customer?.is?.ccmId)
      || call.vehicleCcmId === branch.vehicle?.is?.ccmId
    )))
  );
  replace('user', 'findFirst', async ({ where }) => (
    where.id === creId && where.role === 'FREE_SERVICE_CRE' && where.ccmId === ccmId
      ? freeServiceUser
      : null
  ));
  replace('callLog', 'findMany', async ({ where, orderBy, take }) => {
    const rows = calls.filter((call) => matchesCall(call, where));
    rows.sort((a, b) => (orderBy?.createdAt === 'asc'
      ? a.createdAt.getTime() - b.createdAt.getTime()
      : b.createdAt.getTime() - a.createdAt.getTime()));
    return take ? rows.slice(0, take) : rows;
  });
  replace('callLog', 'groupBy', async ({ where }) => {
    const groups = new Map();
    for (const call of calls.filter((entry) => matchesCall(entry, where))) {
      const key = `${call.createdById}|${call.outcome}`;
      const group = groups.get(key) || { createdById: call.createdById, outcome: call.outcome, _count: { _all: 0 } };
      group._count._all += 1;
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  replace('creCallDaily', 'findMany', async ({ where }) => counterRows.filter((row) => (
    row.userId === where.userId
    && row.ccmId === where.ccmId
    && row.scopeKind === where.scopeKind
    && row.callSource === where.callSource
  )));
  replace('crePerformanceSnapshot', 'findUnique', async ({ where }) => {
    assert.deepEqual(where.creId_ccmId_year_month_viewer, expectedSnapshotKey);
    return snapshotRow;
  });
  t.after(() => originalMethods.reverse().forEach(({ delegate, method, value }) => {
    delegate[method] = value;
  }));

  return {
    calls,
    counterRows,
    dateKey,
    year,
    month,
    expectedSnapshotKey,
    creId,
    ccmId,
    request: (role = 'FREE_SERVICE_CRE', range = 'month') => ({
      user: role === 'CCM'
        ? { id: 'team-ccm', role: 'CCM', ccmId }
        : { ...freeServiceUser, role: 'FREE_SERVICE_CRE' },
      query: {
        year,
        month,
        date: dateKey,
        range,
        ...(role === 'CCM' ? { creId } : {}),
      },
    }),
  };
}

async function callEndpoint(req) {
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await getFreeServicePerformanceSummary(req, response);
  return response;
}

function requestRefreshWithoutRunning(t) {
  const original = globalThis.setImmediate;
  const queued = [];
  globalThis.setImmediate = (callback, ...args) => {
    queued.push(() => callback(...args));
    return { unref() {} };
  };
  t.after(() => { globalThis.setImmediate = original; });
  return queued;
}

test('FREE_SERVICE_CRE live and aggregate API responses retain parity while daily counters remain immediate', async (t) => {
  const fixedNow = new Date();
  const liveWorld = installFreeServiceWorld(t, { enabled: false, now: fixedNow });
  const liveSelf = await callEndpoint(liveWorld.request());
  const liveCcm = await callEndpoint(liveWorld.request('CCM'));
  assert.equal(liveSelf.statusCode, 200);
  assert.deepEqual(liveSelf.body, liveCcm.body, 'a CCM sees the same in-team CRE metrics');
  assert.deepEqual(Object.keys(liveSelf.body).sort(), [
    'callsThisMonth',
    'dailyPerformance',
    'dailyTargets',
    'performanceDate',
    'performanceRange',
    'recentCalls',
    'user',
  ].sort());
  assert.equal(Object.hasOwn(liveSelf.body, 'snapshot'), false, 'flag-off response shape remains unchanged');
  assert.equal(liveSelf.body.user.id, liveWorld.creId);
  assert.equal(liveSelf.body.user.name, 'Free-Service CRE');
  assert.equal(liveSelf.body.user.role, 'FREE_SERVICE_CRE');
  assert.equal(liveSelf.body.performanceDate, liveWorld.dateKey);
  assert.equal(liveSelf.body.performanceRange, 'month');
  assert.deepEqual(liveSelf.body.dailyTargets, {
    callsMade: { actual: 3, target: 120 },
    callsPickedUp: { actual: 2, target: 80 },
  });
  assert.equal(liveSelf.body.callsThisMonth, 3);
  assert.deepEqual(liveSelf.body.dailyPerformance, liveWorld.counterRows.map(({ workshopDate, calls, answeredCalls }) => ({
    date: workshopDate.toISOString().slice(0, 10),
    callsMade: calls,
    callsPickedUp: answeredCalls,
  })));
  assert.deepEqual(liveSelf.body.recentCalls, liveWorld.calls
    .filter((call) => call.ccmId === liveWorld.ccmId && call.callSource === 'FREE_SERVICE' && call.createdById === liveWorld.creId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  const liveToday = await callEndpoint(liveWorld.request('FREE_SERVICE_CRE', 'day'));
  assert.deepEqual(liveToday.body.dailyTargets, {
    callsMade: { actual: 1, target: 120 },
    callsPickedUp: { actual: 1, target: 80 },
  });

  const computedAt = new Date();
  const aggregateWorld = installFreeServiceWorld(t, {
    enabled: true,
    now: fixedNow,
    snapshotRow: {
      ...liveWorld.expectedSnapshotKey,
      callsThisMonth: liveSelf.body.callsThisMonth,
      computedAt,
      asOf: computedAt,
      status: 'ok',
      dirtySince: null,
      lastError: null,
    },
  });
  const aggregateSelf = await callEndpoint(aggregateWorld.request());
  const aggregateCcm = await callEndpoint(aggregateWorld.request('CCM'));
  assert.equal(aggregateSelf.statusCode, 200);
  assert.equal(aggregateSelf.body.snapshot.status, 'ok');
  assert.equal(aggregateSelf.body.snapshot.computedAt.getTime(), computedAt.getTime());
  assert.equal(aggregateSelf.body.snapshot.asOf.getTime(), computedAt.getTime());
  assert.deepEqual(aggregateSelf.body, aggregateCcm.body, 'aggregate reads preserve CCM team isolation');

  const contractFields = ['user', 'performanceDate', 'performanceRange', 'dailyTargets', 'callsThisMonth', 'dailyPerformance', 'recentCalls'];
  for (const field of contractFields) {
    assert.deepEqual(aggregateSelf.body[field], liveSelf.body[field], `${field} must preserve the live response`);
  }
  assert.deepEqual(aggregateSelf.body.dailyTargets, liveSelf.body.dailyTargets);
  const aggregateToday = await callEndpoint(aggregateWorld.request('FREE_SERVICE_CRE', 'day'));
  assert.deepEqual(aggregateToday.body.dailyTargets, liveToday.body.dailyTargets);
});

test('FREE_SERVICE_CRE endpoint rejects other roles and CCMs cannot read another team', async (t) => {
  const world = installFreeServiceWorld(t, { enabled: true });
  const forbidden = await callEndpoint({ user: { id: 'regular-cre', role: 'CRE', ccmId: CCM_ID }, query: world.request().query });
  assert.equal(forbidden.statusCode, 403);

  let queriedCalls = false;
  const originalFindMany = prisma.callLog.findMany;
  prisma.callLog.findMany = async (...args) => {
    queriedCalls = true;
    return originalFindMany(...args);
  };
  t.after(() => { prisma.callLog.findMany = originalFindMany; });
  const denied = await callEndpoint({
    user: { id: 'other-ccm', role: 'CCM', ccmId: 'other-team' },
    query: { ...world.request('CCM').query, creId: CRE_ID },
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(queriedCalls, false, 'a cross-team request must fail before reading call activity');
});

test('missing FREE_SERVICE_CRE snapshots report pending and queue refresh without delaying immediate counters', async (t) => {
  const world = installFreeServiceWorld(t, { enabled: true });
  const scheduled = requestRefreshWithoutRunning(t);
  const response = await callEndpoint(world.request());
  assert.equal(response.body.snapshot.status, 'pending');
  assert.equal(response.body.snapshot.isStale, true);
  assert.equal(response.body.callsThisMonth, null);
  assert.equal(response.body.dailyTargets.callsMade.actual, 3);
  assert.equal(response.body.dailyTargets.callsPickedUp.actual, 2);
  assert.equal(scheduled.length, 1, 'a missing month snapshot should be queued for refresh');
});

test('stale and failed FREE_SERVICE_CRE snapshots expose freshness and retain last-good month values', async (t) => {
  const now = new Date();
  const current = workshopMonthOf(now);
  const currentMonthStart = workshopMonthRange(current.year, current.month).start;
  const historicalDateKey = zonedDateKey(new Date(currentMonthStart.getTime() - 86400000));
  const [historicalYear, historicalMonth] = historicalDateKey.split('-').map(Number);
  const world = installFreeServiceWorld(t, {
    enabled: true,
    now,
    creId: 'stale-free-service-cre',
    dateKey: historicalDateKey,
    snapshotRow: {
      creId: 'stale-free-service-cre',
      ccmId: CCM_ID,
      year: historicalYear,
      month: historicalMonth,
      viewer: 'FREE_SERVICE_CRE',
      callsThisMonth: 9,
      computedAt: new Date(now.getTime() - 16 * 60 * 1000),
      asOf: new Date(now.getTime() - 16 * 60 * 1000),
      status: 'ok',
      dirtySince: null,
      lastError: null,
    },
  });
  const scheduled = requestRefreshWithoutRunning(t);
  const stale = await callEndpoint(world.request());
  assert.equal(stale.body.callsThisMonth, 9);
  assert.equal(stale.body.snapshot.status, 'stale');
  assert.equal(stale.body.snapshot.isStale, true);
  assert.equal(scheduled.length, 1);

  const failedWorld = installFreeServiceWorld(t, {
    enabled: true,
    now,
    creId: 'failed-free-service-cre',
    dateKey: historicalDateKey,
    snapshotRow: {
      ...world.expectedSnapshotKey,
      creId: 'failed-free-service-cre',
      callsThisMonth: 8,
      computedAt: now,
      asOf: now,
      status: 'failed',
      dirtySince: now,
      lastError: 'refresh unavailable',
    },
  });
  const failed = await callEndpoint(failedWorld.request());
  assert.equal(failed.body.callsThisMonth, 8);
  assert.equal(failed.body.snapshot.status, 'failed');
  assert.equal(failed.body.snapshot.isStale, true);
  assert.equal(failed.body.snapshot.lastError, 'refresh unavailable');

  const firstFailureWorld = installFreeServiceWorld(t, {
    enabled: true,
    now,
    creId: 'first-failure-free-service-cre',
    snapshotRow: {
      ...world.expectedSnapshotKey,
      creId: 'first-failure-free-service-cre',
      callsThisMonth: null,
      computedAt: null,
      asOf: null,
      status: 'failed',
      dirtySince: null,
      lastError: 'initial refresh unavailable',
    },
  });
  const firstFailure = await callEndpoint(firstFailureWorld.request());
  assert.equal(firstFailure.body.snapshot.status, 'failed');
  assert.equal(firstFailure.body.snapshot.isStale, true);
  assert.equal(firstFailure.body.snapshot.computedAt, null);
  assert.equal(firstFailure.body.snapshot.lastError, 'initial refresh unavailable');
});

test('dirty and refreshing FREE_SERVICE_CRE snapshots are visibly stale without dropping last-good values', async (t) => {
  const now = new Date();
  requestRefreshWithoutRunning(t);
  for (const status of ['dirty', 'refreshing']) {
    const world = installFreeServiceWorld(t, {
      enabled: true,
      now,
      creId: `${status}-free-service-cre`,
      snapshotRow: {
        creId: `${status}-free-service-cre`,
        ccmId: CCM_ID,
        year: workshopMonthOf(now).year,
        month: workshopMonthOf(now).month,
        viewer: 'FREE_SERVICE_CRE',
        callsThisMonth: 7,
        computedAt: new Date(now.getTime() - 60 * 1000),
        asOf: new Date(now.getTime() - 60 * 1000),
        status,
        dirtySince: status === 'dirty' ? new Date(now.getTime() - 30 * 1000) : null,
        lastError: null,
      },
    });
    const response = await callEndpoint(world.request());
    assert.equal(response.body.callsThisMonth, 7, `${status} retains last-good snapshot values`);
    assert.equal(response.body.snapshot.status, status);
    assert.equal(response.body.snapshot.isStale, true);
  }
});

test('FREE_SERVICE_CRE month snapshot calculation is scoped to its creator, CCM and FREE_SERVICE source', async () => {
  let captured;
  const now = new Date();
  const { year, month } = workshopMonthOf(now);
  const metrics = await computeFreeServiceCrePerformanceMetrics({
    targetCre: { id: CRE_ID, ccmId: CCM_ID },
    year,
    month,
    now,
    db: { callLog: { count: async ({ where }) => { captured = where; return 3; } } },
  });
  assert.equal(metrics.callsThisMonth, 3);
  assert.equal(metrics.asOf.getTime(), now.getTime());
  assert.deepEqual(captured, {
    ccmId: CCM_ID,
    createdById: CRE_ID,
    callSource: 'FREE_SERVICE',
    createdAt: {
      gte: workshopMonthRange(year, month).start,
      lt: workshopMonthRange(year, month).end,
    },
    OR: [
      { vehicleId: null, customer: { is: { ccmId: CCM_ID } } },
      { vehicle: { is: { ccmId: CCM_ID } } },
    ],
  });
});

test('snapshot composite keys isolate viewer role, CCM, CRE and historical periods', async () => {
  const base = { creId: CRE_ID, ccmId: CCM_ID, year: 2026, month: 11 };
  const keys = [
    { ...base, viewer: 'CRE' },
    { ...base, viewer: 'FREE_SERVICE_CRE' },
    { ...base, ccmId: 'another-ccm', viewer: 'FREE_SERVICE_CRE' },
    { ...base, creId: 'another-cre', viewer: 'FREE_SERVICE_CRE' },
    { ...base, year: 2025, month: 10, viewer: 'FREE_SERVICE_CRE' },
  ];
  const records = new Map(keys.map((key, index) => [
    JSON.stringify(key),
    { ...key, callsThisMonth: index + 10 },
  ]));
  const db = {
    crePerformanceSnapshot: {
      findUnique: async ({ where }) => records.get(JSON.stringify(where.creId_ccmId_year_month_viewer)) ?? null,
    },
  };
  const selectors = keys.map((key) => snapshotWhere(key).creId_ccmId_year_month_viewer);
  assert.equal(new Set(selectors.map(JSON.stringify)).size, keys.length, 'all visibility scopes have distinct compound keys');
  const rows = await Promise.all(keys.map((key) => getSnapshot(key, db)));
  assert.deepEqual(rows.map((row) => row.callsThisMonth), [10, 11, 12, 13, 14]);
  assert.deepEqual(rows.map((row) => row.viewer), ['CRE', 'FREE_SERVICE_CRE', 'FREE_SERVICE_CRE', 'FREE_SERVICE_CRE', 'FREE_SERVICE_CRE']);
});

test('FREE_SERVICE_CRE refresh failures preserve last-good data and report failure status', async () => {
  const now = new Date();
  const key = { creId: CRE_ID, ccmId: CCM_ID, ...workshopMonthOf(now), viewer: 'FREE_SERVICE_CRE' };
  const row = {
    ...key,
    status: 'dirty',
    dirtySince: new Date(now.getTime() - 1000),
    failureCount: 0,
    callsThisMonth: 4,
    computedAt: new Date(now.getTime() - 1000),
    refreshStartedAt: null,
    lastAttemptAt: null,
    lastError: null,
  };
  const db = {
    crePerformanceSnapshot: {
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 }; },
      findUnique: async () => row,
    },
    user: {
      findFirst: async ({ where }) => {
        assert.deepEqual(where, { id: CRE_ID, role: 'FREE_SERVICE_CRE' });
        return { id: CRE_ID, name: 'Free-Service CRE', ccmId: CCM_ID };
      },
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await refreshSnapshot(key, {
      now,
      db,
      computeFreeService: async () => { throw new Error('test refresh failure'); },
    });
    assert.equal(result.reason, 'failed');
    assert.equal(row.status, 'failed');
    assert.equal(row.callsThisMonth, 4);
    assert.equal(row.dirtySince.getTime(), now.getTime() - 1000);
    assert.equal(row.lastError, 'test refresh failure');
  } finally {
    console.error = originalError;
  }
});

test('FREE_SERVICE_CRE snapshot refresh calculates and persists its role-specific monthly count', async () => {
  const now = new Date();
  const key = { creId: CRE_ID, ccmId: CCM_ID, ...workshopMonthOf(now), viewer: 'FREE_SERVICE_CRE' };
  const row = { ...key, status: 'pending', dirtySince: null, failureCount: 0 };
  let countWhere;
  const db = {
    crePerformanceSnapshot: {
      createMany: async () => ({ count: 1 }),
      updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 }; },
      findUnique: async () => row,
    },
    user: {
      findFirst: async ({ where }) => {
        assert.deepEqual(where, { id: CRE_ID, role: 'FREE_SERVICE_CRE' });
        return { id: CRE_ID, name: 'Free-Service CRE', ccmId: CCM_ID };
      },
    },
    callLog: {
      count: async ({ where }) => { countWhere = where; return 6; },
    },
  };
  const result = await refreshSnapshot(key, { now, db });
  assert.equal(result.refreshed, true);
  assert.equal(row.status, 'ok');
  assert.equal(row.callsThisMonth, 6);
  assert.equal(row.computedAt.getTime(), now.getTime());
  assert.equal(countWhere.callSource, 'FREE_SERVICE');
  assert.equal(countWhere.createdById, CRE_ID);
  assert.equal(countWhere.ccmId, CCM_ID);
});

test('current-month snapshot seeding includes separate FREE_SERVICE_CRE viewer keys', async () => {
  const inserted = [];
  const db = {
    user: {
      findMany: async ({ where }) => (where.role === 'CRE'
        ? [{ id: 'ordinary-cre', ccmId: CCM_ID }]
        : [{ id: CRE_ID, ccmId: CCM_ID }]),
    },
    crePerformanceSnapshot: {
      createMany: async ({ data }) => { inserted.push(...data); return { count: data.length }; },
    },
  };
  const count = await seedCurrentMonthSnapshots({ now: new Date(), db });
  assert.equal(count, 3);
  assert.ok(inserted.some((row) => row.creId === CRE_ID && row.viewer === 'FREE_SERVICE_CRE'));
  assert.equal(inserted.filter((row) => row.creId === CRE_ID).length, 1);
});
