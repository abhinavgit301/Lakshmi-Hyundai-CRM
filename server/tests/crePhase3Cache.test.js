import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { getCrePerformanceSummary } from '../src/controllers/callWorkflowController.js';
import { invalidateCallListCache } from '../src/utils/callListCache.js';
import { workshopDayRange } from '../src/utils/workshopTime.js';

function makeRes() {
  return {
    statusCode: 200,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function withStubs(fn) {
  const names = [
    [prisma.callLog, 'count'], [prisma.callLog, 'groupBy'], [prisma.callLog, 'findMany'],
    [prisma.followUp, 'count'], [prisma.appointment, 'count'],
    [prisma.monthlyCustomerDataImport, 'findFirst'], [prisma.masterCallList, 'findMany'],
  ];
  const originals = names.map(([target, name]) => target[name]);
  const state = { loads: 0, lifetime: 1 };
  prisma.callLog.count = async () => { state.loads += 1; return state.lifetime; };
  prisma.callLog.groupBy = async () => [];
  prisma.callLog.findMany = async () => [];
  prisma.followUp.count = async () => 0;
  prisma.appointment.count = async () => 0;
  prisma.monthlyCustomerDataImport.findFirst = async () => null;
  prisma.masterCallList.findMany = async () => [];
  invalidateCallListCache();
  try {
    await fn(state);
  } finally {
    names.forEach(([target, name], index) => { target[name] = originals[index]; });
    invalidateCallListCache();
  }
}

function request(user, query) {
  const date = workshopDayRange().dateKey;
  const [year, month] = date.split('-').map(Number);
  return { user, query: { year: String(year), month: String(month), date, ...query } };
}

const creA1 = { id: 'cre-a1', name: 'A1', role: 'CRE', ccmId: 'ccm-a' };
const creA2 = { id: 'cre-a2', name: 'A2', role: 'CRE', ccmId: 'ccm-a' };
const creB1 = { id: 'cre-b1', name: 'B1', role: 'CRE', ccmId: 'ccm-b' };

test('performance summary is served from cache and matches the uncached body', async () => {
  await withStubs(async (state) => {
    const first = makeRes();
    await getCrePerformanceSummary(request(creA1), first);
    const loadsAfterFirst = state.loads;
    const second = makeRes();
    await getCrePerformanceSummary(request(creA1), second);
    assert.equal(state.loads, loadsAfterFirst);
    assert.deepEqual(second.body, first.body);
  });
});

test('performance summary entries are never shared between CREs or CCMs', async () => {
  await withStubs(async (state) => {
    await getCrePerformanceSummary(request(creA1), makeRes());
    const afterA1 = state.loads;
    await getCrePerformanceSummary(request(creA2), makeRes());
    assert.ok(state.loads > afterA1);
    const afterA2 = state.loads;
    await getCrePerformanceSummary(request(creB1), makeRes());
    assert.ok(state.loads > afterA2);
  });
});

test('a workflow invalidation for the same CCM forces a reload, another CCM does not', async () => {
  await withStubs(async (state) => {
    const before = makeRes();
    await getCrePerformanceSummary(request(creA1), before);
    assert.equal(before.body.lifetimeCalls, 1);
    const loads = state.loads;

    invalidateCallListCache({ ccmIds: ['ccm-b'], kinds: ['workflow'] });
    await getCrePerformanceSummary(request(creA1), makeRes());
    assert.equal(state.loads, loads);

    state.lifetime = 2;
    invalidateCallListCache({ ccmIds: ['ccm-a'], kinds: ['workflow'] });
    const after = makeRes();
    await getCrePerformanceSummary(request(creA1), after);
    assert.equal(after.body.lifetimeCalls, 2);
  });
});

test('performance summary still rejects non-CRE roles without touching the cache', async () => {
  await withStubs(async (state) => {
    const res = makeRes();
    await getCrePerformanceSummary(request({ id: 'gm', role: 'GM' }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(state.loads, 0);
  });
});
