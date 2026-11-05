import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { deleteAppointment } from '../src/controllers/appointmentController.js';
import { updateFollowUpStatus } from '../src/controllers/callWorkflowController.js';
import { loadCallListRecords } from '../src/controllers/recordsController.js';
import {
  cachedCallList,
  callListCacheMiddleware,
  getCallListCacheStats,
  invalidateCallListCache,
  resetCallListCacheStats,
  scopeCacheInvalidation,
  withCachedResponse,
} from '../src/utils/callListCache.js';

beforeEach(() => {
  invalidateCallListCache();
  resetCallListCacheStats();
});

let loads = 0;
const loaderFor = (value) => async () => { loads += 1; return value; };
const meta = (kind, ccmId) => ({ kind, ccmId });

async function warm() {
  await cachedCallList('a-master', loaderFor('a-master'), meta('master', 'A'));
  await cachedCallList('a-workflow', loaderFor('a-workflow'), meta('workflow', 'A'));
  await cachedCallList('b-master', loaderFor('b-master'), meta('master', 'B'));
  await cachedCallList('b-workflow', loaderFor('b-workflow'), meta('workflow', 'B'));
  await cachedCallList('admin-master', loaderFor('admin-master'), meta('master', ''));
  loads = 0;
}

async function surviving() {
  const alive = [];
  for (const key of ['a-master', 'a-workflow', 'b-master', 'b-workflow', 'admin-master']) {
    let reloaded = false;
    await cachedCallList(key, async () => { reloaded = true; return key; }, meta('master', 'x'));
    if (!reloaded) alive.push(key);
  }
  return alive;
}

test('a write scoped to CCM A leaves CCM B entries but clears A and the all-CCM (admin) entries', async () => {
  await warm();
  invalidateCallListCache({ ccmIds: ['A'] });
  assert.deepEqual(await surviving(), ['b-master', 'b-workflow']);
});

test('a workflow-only write keeps master entries and clears workflow entries of that CCM and admin views', async () => {
  await warm();
  invalidateCallListCache({ ccmIds: ['A'], kinds: ['workflow'] });
  assert.deepEqual(await surviving(), ['a-master', 'b-master', 'b-workflow', 'admin-master']);
});

test('unknown scope clears every CCM and kind', async () => {
  for (const spec of [undefined, {}, { ccmIds: [] }, { ccmIds: [null] }, { ccmIds: ['A', ''] }]) {
    await warm();
    invalidateCallListCache(spec);
    assert.deepEqual(await surviving(), [], JSON.stringify(spec));
  }
});

test('a load that overlaps a matching write is not cached, but an unrelated one is', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = cachedCallList('slow-a', async () => { await gate; return 'old'; }, meta('master', 'A'));
  const unrelated = cachedCallList('slow-b', async () => { await gate; return 'ok'; }, meta('master', 'B'));
  invalidateCallListCache({ ccmIds: ['A'] });
  release();
  await Promise.all([stale, unrelated]);
  let reloadedA = false;
  await cachedCallList('slow-a', async () => { reloadedA = true; return 'new'; }, meta('master', 'A'));
  let reloadedB = false;
  await cachedCallList('slow-b', async () => { reloadedB = true; return 'x'; }, meta('master', 'B'));
  assert.equal(reloadedA, true);
  assert.equal(reloadedB, false);
});

test('records hits, misses and coalesced requests', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(1), 5));
  await Promise.all([cachedCallList('k', slow), cachedCallList('k', slow)]);
  await cachedCallList('k', slow);
  const stats = getCallListCacheStats();
  assert.deepEqual([stats.misses, stats.coalesced, stats.hits], [1, 1, 1]);
});

test('cached responses are never shared between CRE users of the same CCM', async () => {
  let calls = 0;
  const handler = withCachedResponse('list', async (req, res) => { calls += 1; res.json({ owner: req.user.id }); });
  const reply = () => ({ status() { return this; }, json(body) { this.body = body; return this; } });
  const first = reply();
  const second = reply();
  await handler({ user: { id: 'cre-1', role: 'CRE', ccmId: 'A' }, query: {} }, first);
  await handler({ user: { id: 'cre-2', role: 'CRE', ccmId: 'A' }, query: {} }, second);
  await handler({ user: { id: 'cre-1', role: 'CRE', ccmId: 'A' }, query: {} }, reply());
  assert.deepEqual([first.body.owner, second.body.owner, calls], ['cre-1', 'cre-2', 2]);
});

function writeRequest(spec, statusCode = 200) {
  const res = Object.assign(new EventEmitter(), { statusCode, locals: {} });
  callListCacheMiddleware({ method: 'POST' }, res, () => {});
  if (spec) scopeCacheInvalidation(res, spec);
  res.emit('finish');
}

test('middleware honours the controller scope, defaults to clearing everything, and ignores failed writes', async () => {
  await warm();
  writeRequest({ ccmIds: ['A'] }, 400);
  assert.equal((await surviving()).length, 5);

  await warm();
  writeRequest({ ccmIds: ['A'] });
  assert.deepEqual(await surviving(), ['b-master', 'b-workflow']);

  await warm();
  writeRequest(null);
  assert.deepEqual(await surviving(), []);
});

test('a CCM scoped appointment delete and a follow-up status change declare their CCM and kinds', async () => {
  const original = { ...prisma };
  const originals = {
    appointment: prisma.appointment.findFirst,
    transaction: prisma.$transaction,
    followFirst: prisma.followUp.findFirst,
    followMany: prisma.followUp.updateMany,
    followUnique: prisma.followUp.findUnique,
  };
  prisma.appointment.findFirst = async () => ({ id: 'ap1', ccmId: 'A' });
  prisma.$transaction = async () => undefined;
  prisma.followUp.findFirst = async () => ({ id: 'f1', ccmId: 'A' });
  prisma.followUp.updateMany = async () => ({ count: 1 });
  prisma.followUp.findUnique = async () => ({ id: 'f1' });
  const reply = () => ({ locals: {}, status() { return this; }, json() { return this; } });
  try {
    const appointmentRes = reply();
    await deleteAppointment({ user: { id: 'u', role: 'CCM', ccmId: 'A' }, params: { id: 'ap1' } }, appointmentRes);
    assert.deepEqual(appointmentRes.locals.cacheInvalidation.ccmIds, ['A']);
    assert.equal(appointmentRes.locals.cacheInvalidation.kinds, undefined);

    const followRes = reply();
    await updateFollowUpStatus({ user: { id: 'u', role: 'CCM', ccmId: 'A' }, params: { id: 'f1' }, body: { status: 'completed' } }, followRes);
    assert.deepEqual(followRes.locals.cacheInvalidation, { ccmIds: ['A'], kinds: ['workflow'] });
  } finally {
    prisma.appointment.findFirst = originals.appointment;
    prisma.$transaction = originals.transaction;
    prisma.followUp.findFirst = originals.followFirst;
    prisma.followUp.updateMany = originals.followMany;
    prisma.followUp.findUnique = originals.followUnique;
    void original;
  }
});

test('Master Call List loading never reads call logs or follow-ups (justifies kind scoping of call-log writes)', async () => {
  const captured = [];
  const originalFind = prisma.masterCallList.findMany;
  prisma.masterCallList.findMany = async (args) => { captured.push(args); return []; };
  try {
    await loadCallListRecords({ ccmId: 'A' }, new Date(), { id: 'u', role: 'CCM', ccmId: 'A' });
  } finally {
    prisma.masterCallList.findMany = originalFind;
  }
  assert.ok(captured.length > 0);
  assert.doesNotMatch(JSON.stringify(captured), /callLog|followUp|call_log|follow_up/i);
  const source = readFileSync(new URL('../src/controllers/recordsController.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function loadCallListRecords');
  const end = source.indexOf('async function loadCallListPageResponse');
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /callLog|followUp/);
});

test('only the audited write paths narrow cache invalidation', () => {
  const expected = { callWorkflowController: 3, appointmentController: 3, allocationController: 3, recordsController: 1 };
  for (const [file, count] of Object.entries(expected)) {
    const source = readFileSync(new URL(`../src/controllers/${file}.js`, import.meta.url), 'utf8');
    assert.equal(source.match(/scopeCacheInvalidation\(res,/g)?.length, count, file);
  }
  for (const file of ['importController', 'customerController', 'monthlyCustomerDataController', 'userController']) {
    const source = readFileSync(new URL(`../src/controllers/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /scopeCacheInvalidation/, `${file} touches shared customers/visits and must clear every cache`);
  }
});
