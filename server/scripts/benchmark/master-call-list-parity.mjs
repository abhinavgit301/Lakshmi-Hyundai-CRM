// Phase 1A parity harness. Runs the EXISTING JavaScript Master Call List path and the SQL prototype against the
// same local benchmark database (read-only) and compares totals, complete ordered id lists, pages and hasMore.
//
//   node scripts/benchmark/master-call-list-parity.mjs [--seed 7] [--random 18] [--out file.json] [--quick]
//
// Set TZ (e.g. `$env:TZ='UTC'`) before launching to run under another process timezone; the SQL receives the same
// resolved zone, so the comparison is always like-for-like.
import { writeFileSync } from 'node:fs';
import { configureBenchEnvironment, importApp, openGuardedClient } from './bench-db.mjs';
import { loadMasterCallListPageTwoPhase, runMasterCallListPage } from './master-call-list-prototype.mjs';

configureBenchEnvironment();

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const SEED = Number(arg('seed', 7));
const RANDOM_COMBOS = Number(arg('random', 18));
const QUICK = argv.includes('--quick');
const OUT = arg('out', null);

const { prisma } = await importApp('config/prisma.js');
const records = await importApp('controllers/recordsController.js');
const masterList = await importApp('utils/masterCallList.js');
const { validateMasterCallListFilters } = await importApp('utils/masterCallListFilters.js');
const { MASTER_REPAIR_TYPES } = await importApp('utils/repairTypes.js');
const client = await openGuardedClient();
await client.query('SET statement_timeout = 60000');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HUGE = Number.MAX_SAFE_INTEGER;
const app = { records, masterList, prisma };

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);
const choice = (list) => list[Math.floor(random() * list.length)];

const realInfo = console.info;
const silence = async (fn) => {
  console.info = () => {};
  try { return await fn(); } finally { console.info = realInfo; }
};

const users = await prisma.user.findMany({
  where: { role: { in: ['ADMIN', 'GM', 'CCM', 'CRE'] }, status: 'active' },
  orderBy: [{ role: 'asc' }, { id: 'asc' }],
});
const cres = users.filter((user) => user.role === 'CRE');
const ccmIds = [...new Set(users.filter((u) => u.role === 'CCM').map((u) => u.ccmId))];

// --- search terms drawn from real rows so they hit, plus hostile ones --------------------------------------
const sample = (await client.query(`
  SELECT m."customerName", m.vin, m."registrationNumber", m."mobileNumber",
         (SELECT w."repairOrderNo" FROM workshop_visits w JOIN vehicles v ON v."physicalVehicleId" = w."physicalVehicleId"
           WHERE v.id = m."vehicleId" LIMIT 1) AS ro
  FROM master_call_lists m ORDER BY md5(m.id) LIMIT 40`)).rows;
const searchTerms = ['test', 'aarav', 'test aarav', 'zzzzzz-no-match', '%', '_', "'", '\\', 'ÅÄÖ', 'MH', '12', 'ro-'];
for (const row of sample.slice(0, 12)) {
  searchTerms.push(row.customerName.split(' ').pop(), row.vin.slice(3, 9), row.vin, String(row.registrationNumber || '').slice(0, 5),
    String(row.mobileNumber).slice(2, 7), String(row.ro || '').slice(0, 6), String(row.ro || '').toUpperCase());
}
const searchPool = [...new Set(searchTerms.filter(Boolean))];

function comboFilters(role, parts) {
  const query = { ...parts };
  if (!['CCM', 'ADMIN', 'GM'].includes(role)) delete query.creId;
  const validated = validateMasterCallListFilters(query);
  if (validated.error) throw new Error(validated.error);
  return validated.filters;
}

function buildCombos(role) {
  const combos = [{}];
  for (const dueCategory of ['6m', '1y', 'allDue', 'pastDue']) combos.push({ dueCategory });
  for (const repairType of MASTER_REPAIR_TYPES) combos.push({ repairType });
  if (['CCM', 'ADMIN', 'GM'].includes(role)) {
    combos.push({ creId: 'unassigned' }, { creId: choice(cres).id }, { creId: 'does-not-exist' });
  }
  for (const term of QUICK ? searchPool.slice(0, 4) : searchPool.slice(0, 16)) combos.push({ search: term });
  const mixes = QUICK ? 4 : RANDOM_COMBOS;
  for (let index = 0; index < mixes; index += 1) {
    const mix = {};
    if (random() < 0.6) mix.dueCategory = choice(['6m', '1y', 'allDue', 'pastDue']);
    if (random() < 0.5) mix.repairType = choice(MASTER_REPAIR_TYPES);
    if (random() < 0.4 && ['CCM', 'ADMIN', 'GM'].includes(role)) mix.creId = choice(['unassigned', choice(cres).id]);
    if (random() < 0.5) mix.search = choice(searchPool);
    combos.push(mix);
  }
  return combos;
}

// --- existing JS path (full ordered list = same function, page window opened fully) ---------------------------
const oldCache = new Map();
async function oldFull(user, requestedCcmId, filters, now) {
  const key = JSON.stringify([user.id, requestedCcmId, filters, now.getTime()]);
  if (oldCache.has(key)) return oldCache.get(key);
  const scope = await records.resolveMasterCallListVisibility(user, requestedCcmId);
  let result;
  if (scope.error) {
    result = { error: scope.error };
  } else {
    result = await silence(async () => {
      let queue = [];
      if (user.role === 'CCM') {
        const unassigned = await prisma.allocation.findMany({
          where: { ccmId: user.ccmId || 'no-access', status: 'assigned', creId: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true, ccmId: true, serviceType: true,
            vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true, customer: { select: { id: true } } } },
          },
        });
        queue = masterList.buildAllocationQueueRecords([], unassigned, user.ccmId || 'no-access');
      }
      return records.loadCallListRecords(scope.where, now, user, {
        page: { limit: HUGE, offset: 0 }, filters, allocationQueueRecords: queue,
      });
    });
  }
  if (oldCache.size > 400) oldCache.clear();
  oldCache.set(key, result);
  return result;
}

const stats = { combos: 0, comparisons: 0, pageChecks: 0, recordChecks: 0, mismatches: [], variants: {}, nonEmpty: 0, empty: 0, queueRecordsSeen: 0 };
const note = (kind, detail) => {
  if (stats.mismatches.length < 60) stats.mismatches.push({ kind, ...detail });
  stats.mismatchCount = (stats.mismatchCount || 0) + 1;
};

async function compare({ user, requestedCcmId = '', filters, now, today, options, label, deep = false }) {
  const variant = `${options.strictVisibility ? 'strict' : 'lax'}/${options.idCollation}`;
  stats.variants[variant] = (stats.variants[variant] || 0) + 1;
  const old = await oldFull(user, requestedCcmId, filters, now);
  const sql = await runMasterCallListPage(client, {
    user, filters, requestedCcmId, now, today, options, pagination: { limit: HUGE, offset: 0 },
  });
  const ctx = { variant, label, user: user.id, role: user.role, requestedCcmId, filters, now: now.toISOString() };
  stats.comparisons += 1;
  if (old.error) {
    if (!sql.forbidden) note('forbidden-mismatch', ctx);
    return;
  }
  if (sql.forbidden) { note('forbidden-mismatch', ctx); return; }
  const oldIds = old.records.map((record) => record.id);
  stats.queueRecordsSeen += old.records.filter((record) => record.allocationOnly).length;
  if (old.total === 0) stats.empty += 1; else stats.nonEmpty += 1;
  if (old.total !== sql.total) note('total', { ...ctx, old: old.total, sql: sql.total });
  if (oldIds.length !== sql.ids.length || oldIds.some((id, index) => id !== sql.ids[index])) {
    const firstDiff = oldIds.findIndex((id, index) => id !== sql.ids[index]);
    note('ordered-ids', {
      ...ctx, oldLength: oldIds.length, sqlLength: sql.ids.length, firstDiff,
      onlyInOld: oldIds.filter((id) => !sql.ids.includes(id)).slice(0, 5),
      onlyInSql: sql.ids.filter((id) => !oldIds.includes(id)).slice(0, 5),
      oldAt: oldIds.slice(Math.max(0, firstDiff), firstDiff + 3), sqlAt: sql.ids.slice(Math.max(0, firstDiff), firstDiff + 3),
    });
  }
  const oldQueue = old.records.filter((record) => record.allocationOnly).map((record) => record.id);
  if (JSON.stringify(oldQueue) !== JSON.stringify(sql.queueIds)) note('queue-ids', { ...ctx, old: oldQueue.slice(0, 5), sql: sql.queueIds.slice(0, 5) });

  // page windows
  const total = old.total;
  const windows = QUICK
    ? [[50, 0], [50, 50]]
    : [[50, 0], [50, 50], [50, 100], [7, 3], [1, 0], [50, Math.max(0, total - 1)], [50, total], [10, total + 25], [50, Math.max(0, total - 51)]];
  for (const [limit, offset] of windows) {
    const page = await runMasterCallListPage(client, { user, filters, requestedCcmId, now, today, options, pagination: { limit, offset } });
    const expected = oldIds.slice(offset, offset + limit);
    stats.pageChecks += 1;
    const hasMoreOld = offset + expected.length < total;
    const hasMoreSql = offset + page.ids.length < page.total;
    if (JSON.stringify(expected) !== JSON.stringify(page.ids) || page.total !== total || hasMoreOld !== hasMoreSql) {
      note('page', { ...ctx, limit, offset, expected: expected.slice(0, 3), got: page.ids.slice(0, 3), totalOld: total, totalSql: page.total });
    }
  }

  if (deep) {
    for (const offset of [0, Math.min(total, 50)]) {
      if (offset >= total && offset !== 0) continue;
      const two = await silence(() => loadMasterCallListPageTwoPhase({
        app, queryable: client, user, requestedCcmId, filters, pagination: { limit: 50, offset }, now, today, options,
      }));
      const expected = old.records.slice(offset, offset + 50);
      stats.recordChecks += 1;
      if (two.missingIds.length) note('missing-detail-records', { ...ctx, offset, missing: two.missingIds.slice(0, 3) });
      if (JSON.stringify(two.records) !== JSON.stringify(expected) || two.total !== total
        || two.hasMore !== (offset + expected.length < total)) {
        const index = two.records.findIndex((record, i) => JSON.stringify(record) !== JSON.stringify(expected[i]));
        note('two-phase-records', { ...ctx, offset, index, got: two.records[index]?.id, expected: expected[index]?.id });
      }
    }
  }
}

const started = performance.now();
const today = new Date();
const baseOptions = { timeZone, idCollation: 'C', strictVisibility: false };
console.log(`parity: tz=${timeZone} users=${users.length} seed=${SEED} quick=${QUICK}`);

// 1) every user x filter combos (lax visibility, C collation, real now)
for (const user of users) {
  const combos = buildCombos(user.role);
  for (const [index, parts] of combos.entries()) {
    const filters = comboFilters(user.role, parts);
    stats.combos += 1;
    await compare({ user, filters, now: today, today, options: baseOptions, label: 'base', deep: index % 4 === 0 });
  }
  console.log(`  ${user.role.padEnd(5)} ${user.id.padEnd(12)} combos=${combos.length} mismatches so far=${stats.mismatchCount || 0} (${((performance.now() - started) / 1000).toFixed(0)}s)`);
}

// 2) Admin / GM with an explicit ccmId (allowed and, for GM, forbidden)
for (const requestedCcmId of [...ccmIds, 'ccm-not-real']) {
  for (const user of users.filter((u) => u.role === 'ADMIN' || u.role === 'GM')) {
    for (const parts of [{}, { dueCategory: 'allDue' }, { repairType: 'PMS' }, { search: 'test' }]) {
      await compare({ user, requestedCcmId, filters: comboFilters(user.role, parts), now: today, today, options: baseOptions, label: 'requested-ccm', deep: true });
    }
  }
}

// 3) strict visibility + ICU id collation variants on a representative subset
if (!QUICK) {
  for (const user of users) {
    for (const parts of [{}, { dueCategory: 'allDue' }, { dueCategory: 'pastDue' }, { repairType: 'Paid' }, { repairType: 'Free' }, { search: 'test' }]) {
      const filters = comboFilters(user.role, parts);
      await compare({ user, filters, now: today, today, options: { ...baseOptions, strictVisibility: true }, label: 'strict' });
      await compare({ user, filters, now: today, today, options: { ...baseOptions, idCollation: 'icu' }, label: 'icu' });
    }
  }
}

// 4) time travel: shift `now` across month boundaries (local zone) so 6m/1y cohorts, Feb 29 and month edges move.
const nows = [
  new Date(2026, 10, 1, 0, 0, 0, 0), new Date(2026, 9, 31, 23, 59, 59, 999), new Date(2026, 5, 30, 23, 59, 59, 999),
  new Date(2026, 6, 1, 0, 0, 0, 0), new Date(2026, 2, 1, 0, 0, 0, 0), new Date(2025, 1, 28, 23, 59, 59, 999),
  new Date(2025, 2, 1, 0, 0, 0, 0), new Date(2024, 1, 29, 12, 0, 0, 0), new Date(2025, 5, 15, 12, 0, 0, 0),
  new Date(2024, 11, 31, 23, 59, 59, 999), new Date(2027, 0, 1, 0, 0, 0, 0),
];
const shiftUsers = [users.find((u) => u.role === 'ADMIN'), users.find((u) => u.role === 'GM'), users.find((u) => u.role === 'CCM'), users.find((u) => u.role === 'CRE')];
for (const now of QUICK ? nows.slice(0, 2) : nows) {
  for (const user of shiftUsers) {
    for (const parts of [{ dueCategory: '6m' }, { dueCategory: '1y' }, { dueCategory: 'allDue' }, { repairType: 'Free', dueCategory: 'allDue' }]) {
      await compare({ user, filters: comboFilters(user.role, parts), now, today, options: baseOptions, label: `now=${now.toISOString()}`, deep: false });
    }
  }
}

const summary = {
  timeZone, seed: SEED, seconds: Math.round((performance.now() - started) / 1000),
  users: users.length, combos: stats.combos, comparisons: stats.comparisons, pageChecks: stats.pageChecks,
  twoPhaseRecordChecks: stats.recordChecks, variants: stats.variants, nonEmptyComparisons: stats.nonEmpty,
  emptyComparisons: stats.empty, queueRecordsCompared: stats.queueRecordsSeen,
  mismatchCount: stats.mismatchCount || 0, mismatches: stats.mismatches,
};
console.log(JSON.stringify({ ...summary, mismatches: summary.mismatches.slice(0, 8) }, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));
await client.end();
await prisma.$disconnect();
process.exit(summary.mismatchCount ? 1 : 0);
