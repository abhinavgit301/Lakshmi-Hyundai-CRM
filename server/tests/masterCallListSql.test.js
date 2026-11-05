import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { getCallList } from '../src/controllers/recordsController.js';
import { getCallListCacheStats, invalidateCallListCache } from '../src/utils/callListCache.js';
import { buildMasterCallListPageSql, isMasterCallListSqlEnabled, resetPostgresTimeZoneCache, runMasterCallListPagePrisma } from '../src/utils/masterCallListSql.js';
import { canonicalWorkshopTimezone } from '../src/utils/workshopTime.js';

// DB-free tests of the MASTER_CALL_LIST_SQL_ENABLED path. The SQL itself is validated against the legacy
// implementation by the benchmark parity/fixture harnesses (scripts/benchmark); here the statement text, the
// feature flag, the two-phase loading, the queue, visibility and cache behaviour are checked with stubbed Prisma.

const FLAG = 'MASTER_CALL_LIST_SQL_ENABLED';
let sequence = 0;

function row(id, vin, overrides = {}) {
  return {
    id,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: `Customer ${id}`,
    mobileNumber: '',
    vin,
    status: 'pending',
    registrationNumber: null,
    vehicle: null,
    ...overrides,
  };
}

async function withFlag(value, fn) {
  const previous = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env[FLAG]; else process.env[FLAG] = previous;
  }
}

// `page` = what the SQL statement would return: { total, forbidden, ids, queueIds }.
async function request({ user, query = {}, page, rows = [], allocations = [], teams = [] }) {
  const original = {
    raw: prisma.$queryRawUnsafe,
    master: prisma.masterCallList.findMany,
    user: prisma.user.findMany,
    allocation: prisma.allocation.findMany,
  };
  const calls = { sql: [], master: [], allocation: [] };
  prisma.$queryRawUnsafe = async (text, ...values) => {
    if (text.includes('pg_timezone_names')) return values[0].slice(0, 1).map((name) => ({ name }));
    calls.sql.push({ text, values });
    const result = typeof page === 'function' ? page() : page;
    const body = result.ids.length
      ? result.ids.map((id) => ({ total: result.total, forbidden: result.forbidden === true, id, is_queue: (result.queueIds || []).includes(id) }))
      : [{ total: result.total, forbidden: result.forbidden === true, id: null, is_queue: null }];
    return body;
  };
  prisma.masterCallList.findMany = async (args) => {
    calls.master.push(args);
    const wanted = args.where?.AND?.[1]?.id?.in;
    return rows.filter((r) => !wanted || wanted.includes(r.id)).slice(0, args.take);
  };
  prisma.user.findMany = async (args) => (args?.where?.role === 'CCM' ? teams : []);
  prisma.allocation.findMany = async (args) => { calls.allocation.push(args); return allocations; };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await getCallList({ user: { id: `sql-user-${++sequence}`, ...user }, query }, res);
    return { status: res.statusCode, body: res.body, calls };
  } finally {
    prisma.$queryRawUnsafe = original.raw;
    prisma.masterCallList.findMany = original.master;
    prisma.user.findMany = original.user;
    prisma.allocation.findMany = original.allocation;
  }
}

const ids = (response) => response.body.records.map((record) => record.id);
const buildFor = (user, extra = {}) => buildMasterCallListPageSql({
  user,
  filters: {},
  pagination: { limit: 50, offset: 0 },
  options: { timeZone: 'Asia/Kolkata', idCollation: 'icu' },
  ...extra,
});

test('feature flag: unset, empty, false and unrecognised values stay OFF; only true/1 enable', () => {
  for (const value of [undefined, '', ' ', 'false', '0', 'no', 'yes', 'on', 'enable', 'truee', 'null', 'undefined']) {
    assert.equal(isMasterCallListSqlEnabled({ [FLAG]: value }), false, String(value));
  }
  assert.equal(isMasterCallListSqlEnabled({}), false);
  for (const value of ['true', 'TRUE', ' True ', '1']) {
    assert.equal(isMasterCallListSqlEnabled({ [FLAG]: value }), true, value);
  }
});

test('flag OFF (unset or invalid) runs the original path and never issues the SQL statement', async () => {
  for (const value of [undefined, 'false', 'garbage']) {
    const response = await withFlag(value, () => request({
      user: { role: 'ADMIN' },
      rows: [row('m-1', 'VIN-1')],
      page: { total: 99, ids: ['m-ignored'] },
    }));
    assert.equal(response.calls.sql.length, 0, String(value));
    assert.deepEqual(ids(response), ['m-1'], String(value));
    assert.equal(response.body.total, 1, String(value));
  }
});

test('flag ON selects the page through SQL and loads only those ids with the existing record builder', async () => {
  const rows = [row('m-1', 'VIN-1'), row('m-2', 'VIN-2'), row('m-3', 'VIN-3')];
  const response = await withFlag('true', () => request({
    user: { role: 'ADMIN' },
    query: { limit: '2', offset: '1' },
    rows,
    page: { total: 3, ids: ['m-3', 'm-1'] },
  }));

  assert.equal(response.calls.sql.length, 1);
  assert.deepEqual(ids(response), ['m-3', 'm-1']);
  assert.deepEqual(Object.keys(response.body).sort(), ['hasMore', 'limit', 'offset', 'records', 'total']);
  assert.equal(response.body.total, 3);
  assert.equal(response.body.limit, 2);
  assert.equal(response.body.offset, 1);
  assert.equal(response.body.hasMore, false);
  // Phase 2 only reads the selected ids, not every visible row.
  assert.ok(response.calls.master.length >= 1);
  for (const call of response.calls.master) assert.deepEqual(call.where.AND[1], { id: { in: ['m-3', 'm-1'] } });
  const first = response.body.records[0];
  for (const key of ['id', 'name', 'vin', 'status', 'workshopVisits', 'assigneeName', 'dueCategory']) assert.ok(key in first, key);
});

test('flag ON: pagination arithmetic and empty pages', async () => {
  const rows = [row('m-1', 'VIN-1')];
  const more = await withFlag('true', () => request({ user: { role: 'ADMIN' }, rows, query: { limit: '1' }, page: { total: 5, ids: ['m-1'] } }));
  assert.equal(more.body.hasMore, true);
  assert.equal(more.body.total, 5);
  assert.ok(more.calls.sql[0].values.includes('1'), 'limit bound');

  const empty = await withFlag('true', () => request({ user: { role: 'ADMIN' }, rows, query: { offset: '40' }, page: { total: 5, ids: [] } }));
  assert.deepEqual(ids(empty), []);
  assert.equal(empty.body.total, 5);
  assert.equal(empty.body.hasMore, false);
  assert.equal(empty.calls.master.length, 0, 'no detail load for an empty page');
});

test('flag ON: CCM queue entries come from allocations, keep SQL order and never leak other CCMs', async () => {
  const rows = [row('m-1', 'VIN-1')];
  const allocations = [
    { id: 'al-q', ccmId: 'ccm-a', serviceType: 'Free', vehicle: { id: 'v-q', vin: 'VIN-Q', model: 'M', registrationNumber: 'REG', customer: null } },
    { id: 'al-1', ccmId: 'ccm-a', serviceType: 'Paid', vehicle: { id: 'v-1', vin: 'VIN-1', model: 'M', registrationNumber: null, customer: null } },
    { id: 'al-nov', ccmId: 'ccm-a', serviceType: 'Paid', vehicle: null },
    { id: 'al-empty', ccmId: 'ccm-a', serviceType: 'Paid', vehicle: { id: 'v-e', vin: '', model: 'M', registrationNumber: null, customer: null } },
  ];
  const response = await withFlag('true', () => request({
    user: { role: 'CCM', ccmId: 'ccm-a' },
    rows,
    allocations,
    page: { total: 2, ids: ['m-1', 'allocation:al-q'], queueIds: ['allocation:al-q'] },
  }));

  assert.deepEqual(ids(response), ['m-1', 'allocation:al-q']);
  assert.equal(response.body.records[0].allocationQueue, true);
  assert.equal(response.body.records[1].allocationOnly, true);
  assert.equal(response.calls.allocation.length, 1);
  assert.deepEqual(response.calls.allocation[0].where, { ccmId: 'ccm-a', status: 'assigned', creId: null });
  // The statement itself is bound to the requesting CCM.
  assert.ok(response.calls.sql[0].values.includes('ccm-a'));
  assert.ok(!response.calls.sql[0].values.includes('ccm-b'));
});

test('flag ON: Admin, GM and CRE never query allocations', async () => {
  for (const user of [{ role: 'ADMIN' }, { role: 'GM', id: 'gm-sql' }, { role: 'CRE', id: 'cre-sql', ccmId: 'ccm-a' }]) {
    const response = await withFlag('true', () => request({
      user,
      rows: [row('m-1', 'VIN-1', { ownerUserId: 'cre-sql' })],
      page: { total: 1, ids: ['m-1'] },
      teams: [{ ccmId: 'ccm-a' }],
    }));
    assert.equal(response.status, 200, user.role);
    assert.equal(response.calls.allocation.length, 0, user.role);
    assert.ok(!response.calls.sql[0].text.includes('queue AS'), user.role);
  }
});

test('flag ON: role scope is re-applied when records are loaded, and CRE/CCM scoping is bound in SQL', async () => {
  const cre = await withFlag('true', () => request({
    user: { role: 'CRE', id: 'cre-scope', ccmId: 'ccm-a' },
    rows: [row('m-1', 'VIN-1', { ownerUserId: 'cre-scope' })],
    page: { total: 1, ids: ['m-1'] },
  }));
  assert.deepEqual(cre.calls.master[0].where.AND[0], { ccmId: 'ccm-a', ownerUserId: 'cre-scope' });
  assert.ok(cre.calls.sql[0].values.includes('cre-scope'));

  const ccm = await withFlag('true', () => request({
    user: { role: 'CCM', ccmId: 'ccm-a' },
    rows: [row('m-1', 'VIN-1')],
    page: { total: 1, ids: ['m-1'] },
  }));
  assert.deepEqual(ccm.calls.master[0].where.AND[0], { ccmId: 'ccm-a' });

  const admin = await withFlag('true', () => request({
    user: { role: 'ADMIN' },
    rows: [row('m-1', 'VIN-1')],
    page: { total: 1, ids: ['m-1'] },
  }));
  assert.deepEqual(admin.calls.master[0].where.AND[0], {});
});

test('flag ON: forbidden GM team and Free-Service CRE are refused and the refusal is not cached', async () => {
  const user = { role: 'GM', id: 'gm-forbidden' };
  let forbidden = true;
  const page = () => ({ total: 0, forbidden, ids: [] });
  const first = await withFlag('true', () => request({ user, query: { ccmId: 'ccm-z' }, page }));
  assert.equal(first.status, 403);
  assert.equal(first.body.message, 'You are not permitted to view this CCM team.');

  // Same user/query again: the 403 must be recomputed, not served from cache.
  const original = prisma.$queryRawUnsafe;
  forbidden = false;
  const second = await withFlag('true', async () => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    prisma.$queryRawUnsafe = async (text) => (text.includes('pg_timezone_names') ? [{ name: 'Asia/Kolkata' }] : [{ total: 0, forbidden: false, id: null, is_queue: null }]);
    try { await getCallList({ user, query: { ccmId: 'ccm-z' } }, res); } finally { prisma.$queryRawUnsafe = original; }
    return res;
  });
  assert.equal(second.statusCode, 200);

  const free = await withFlag('true', () => request({ user: { role: 'FREE_SERVICE_CRE', ccmId: 'ccm-a' }, page: { total: 0, ids: [] } }));
  assert.equal(free.status, 403);
  assert.equal(free.calls.sql.length, 0);
});

test('flag ON: validation errors are returned before any SQL runs', async () => {
  const response = await withFlag('true', () => request({
    user: { role: 'ADMIN' },
    query: { dueCategory: 'bogus' },
    page: { total: 0, ids: [] },
  }));
  assert.equal(response.status, 400);
  assert.equal(response.calls.sql.length, 0);
});

const ttlSeconds = Number.parseInt(process.env.CALL_LIST_CACHE_TTL_SECONDS, 10);
test('flag ON: responses use the shared call-list cache and are dropped by invalidation', { skip: ttlSeconds === 0 }, async () => {
  invalidateCallListCache();
  const user = { role: 'ADMIN', id: 'cache-admin' };
  const run = () => withFlag('true', async () => {
    const original = { raw: prisma.$queryRawUnsafe, master: prisma.masterCallList.findMany, user: prisma.user.findMany };
    let sqlCalls = 0;
    prisma.$queryRawUnsafe = async (text) => {
      if (text.includes('pg_timezone_names')) return [{ name: 'Asia/Kolkata' }];
      sqlCalls += 1;
      return [{ total: 1, forbidden: false, id: 'm-1', is_queue: false }];
    };
    prisma.masterCallList.findMany = async () => [row('m-1', 'VIN-1')];
    prisma.user.findMany = async () => [];
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    try { await getCallList({ user, query: { limit: '10' } }, res); } finally {
      prisma.$queryRawUnsafe = original.raw;
      prisma.masterCallList.findMany = original.master;
      prisma.user.findMany = original.user;
    }
    return { sqlCalls, body: res.body };
  });

  const before = getCallListCacheStats().hits;
  assert.equal((await run()).sqlCalls, 1);
  assert.equal((await run()).sqlCalls, 0);
  assert.equal(getCallListCacheStats().hits, before + 1);
  invalidateCallListCache();
  assert.equal((await run()).sqlCalls, 1);
});

test('statement text: scope, collation and timezone', () => {
  const tz = canonicalWorkshopTimezone();
  assert.equal(typeof tz, 'string');
  const defaults = buildMasterCallListPageSql({ user: { role: 'ADMIN' }, filters: { dueCategory: '1y' }, pagination: { limit: 50, offset: 0 } });
  assert.ok(defaults.values.includes(tz), 'timezone defaults to the shared workshop timezone');

  const ccm = buildFor({ role: 'CCM', ccmId: 'ccm-a' });
  assert.match(ccm.text, /m\."ccmId" = \$\d+::text/);
  assert.match(ccm.text, /queue AS \(/);
  assert.match(ccm.text, /a\.status = 'assigned' AND a\."creId" IS NULL/);
  assert.match(ccm.text, /NOT EXISTS \(SELECT 1 FROM scoped s/);

  const cre = buildFor({ role: 'CRE', id: 'cre-1', ccmId: 'ccm-a' });
  assert.match(cre.text, /m\."ownerUserId" = \$\d+::text/);
  assert.ok(!cre.text.includes('queue AS ('));

  const gm = buildFor({ role: 'GM', id: 'gm-1' });
  assert.match(gm.text, /u\.role = 'CCM' AND u\.status = 'active'/);
  assert.ok(!gm.text.includes('queue AS ('));

  const unknown = buildFor({ role: 'SOMETHING_ELSE' });
  assert.match(unknown.text, /scoped AS \(SELECT m\.\* FROM master_call_lists m WHERE false\)/);

  // Canonicalisation happens after scoping, ordered by owner, createdAt, then id.
  assert.match(ccm.text, /canonical AS \(\s*SELECT DISTINCT ON \(m\."ccmId", m\.vin\) m\.\*\s*FROM scoped m/);
  assert.match(ccm.text, /COLLATE "und-x-icu"/);
  assert.ok(!ccm.text.includes('COLLATE "C"'));
});

test('statement text: user input is only ever bound, never interpolated', () => {
  const hostile = "x'); DROP TABLE users; --";
  const { text, values } = buildMasterCallListPageSql({
    user: { role: 'ADMIN', id: hostile },
    filters: { search: hostile.toLowerCase(), creId: hostile, repairType: 'Paid', dueCategory: '1y' },
    pagination: { limit: 50, offset: 0 },
    requestedCcmId: hostile,
    options: { timeZone: 'Asia/Kolkata', idCollation: 'icu' },
  });
  assert.ok(!text.includes('DROP TABLE'));
  assert.ok(values.includes(hostile));
  assert.ok(values.includes(hostile.toLowerCase()));
  const maxIndex = Math.max(...[...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
  assert.equal(maxIndex, values.length, 'every bound value is referenced exactly in sequence');
});

test('runMasterCallListPagePrisma always orders ids with ICU, even if C is requested', async () => {
  let captured;
  const fake = { $queryRawUnsafe: async (text, ...values) => { captured = { text, values }; return [{ total: 0, forbidden: false, id: null, is_queue: null }]; } };
  const result = await runMasterCallListPagePrisma(fake, {
    user: { role: 'CCM', ccmId: 'ccm-a' },
    filters: {},
    pagination: { limit: 50, offset: 0 },
    options: { idCollation: 'C', timeZone: 'Asia/Kolkata' },
  });
  assert.deepEqual(result, { forbidden: false, total: 0, ids: [], queueIds: [] });
  assert.match(captured.text, /COLLATE "und-x-icu"/);
  assert.ok(!captured.text.includes('COLLATE "C"'));
});

test('timezone sent to PostgreSQL is an identifier the database recognises (legacy aliases such as Asia/Calcutta may be absent)', async () => {
  const previous = process.env.WORKSHOP_TIMEZONE;
  const run = async (known) => {
    resetPostgresTimeZoneCache();
    const seen = [];
    const fake = {
      $queryRawUnsafe: async (text, ...values) => {
        if (text.includes('pg_timezone_names')) { seen.push(values[0]); return values[0].filter((name) => known.includes(name)).map((name) => ({ name })); }
        seen.push(values);
        return [{ total: 0, forbidden: false, id: null, is_queue: null }];
      },
    };
    const result = await runMasterCallListPagePrisma(fake, { user: { role: 'ADMIN' }, filters: { dueCategory: '1y' }, pagination: { limit: 50, offset: 0 } });
    return { result, seen };
  };
  try {
    process.env.WORKSHOP_TIMEZONE = 'Asia/Kolkata';
    // Node canonicalises to Asia/Calcutta; PostgreSQL 18.6 (Debian) only knows Asia/Kolkata.
    const modern = await run(['Asia/Kolkata']);
    assert.ok(modern.seen[0].includes('Asia/Kolkata'));
    assert.ok(modern.seen[1].includes('Asia/Kolkata'), 'statement is bound with the recognised identifier');
    assert.ok(!modern.seen[1].includes('Asia/Calcutta'));
    // A database that only knows the canonical name still works.
    const legacy = await run(['Asia/Calcutta']);
    assert.ok(legacy.seen[1].includes('Asia/Calcutta'));
    // Neither known: fail loudly rather than run with an unknown zone.
    await assert.rejects(() => run([]), /does not recognise the workshop timezone/);
  } finally {
    if (previous === undefined) delete process.env.WORKSHOP_TIMEZONE; else process.env.WORKSHOP_TIMEZONE = previous;
    resetPostgresTimeZoneCache();
  }
});

test('flag ON: a selected id that cannot be built fails loudly, is not cached, and never returns a short page', async () => {
  const user = { role: 'ADMIN', id: 'incomplete-admin' };
  const attempt = () => withFlag('true', async () => {
    const original = { raw: prisma.$queryRawUnsafe, master: prisma.masterCallList.findMany, user: prisma.user.findMany };
    prisma.$queryRawUnsafe = async (text) => (text.includes('pg_timezone_names')
      ? [{ name: 'Asia/Kolkata' }]
      : [{ total: 2, forbidden: false, id: 'm-1', is_queue: false }, { total: 2, forbidden: false, id: 'm-gone', is_queue: false }]);
    prisma.masterCallList.findMany = async () => [row('m-1', 'VIN-1')];
    prisma.user.findMany = async () => [];
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    try {
      await getCallList({ user, query: {} }, res);
      return { res };
    } catch (error) {
      return { error, res };
    } finally {
      prisma.$queryRawUnsafe = original.raw;
      prisma.masterCallList.findMany = original.master;
      prisma.user.findMany = original.user;
    }
  });
  const first = await attempt();
  assert.equal(first.error?.code, 'MASTER_CALL_LIST_PAGE_INCOMPLETE');
  assert.deepEqual(first.error.missingIds, ['m-gone']);
  assert.equal(first.res.body, undefined);
  const second = await attempt();
  assert.equal(second.error?.code, 'MASTER_CALL_LIST_PAGE_INCOMPLETE', 'failure was not cached');
});
