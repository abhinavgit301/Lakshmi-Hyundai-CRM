// Phase 1A performance comparison: existing Master Call List controller vs the two-phase SQL prototype.
// Local benchmark database only (guarded read-only connection). Nothing is written anywhere except the JSON result file.
//
//   node scripts/benchmark/master-call-list-perf.mjs --impl old|new [--iterations 20] [--out file.json]
//   node scripts/benchmark/master-call-list-perf.mjs --experiment [--out file.json]     (1143 ms vs ~640 ms investigation)
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { configureBenchEnvironment, importApp, openGuardedClient, requirePg } from './bench-db.mjs';

configureBenchEnvironment();
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const iterations = Number(flag('--iterations', 20));
const outFile = flag('--out');
const realInfo = console.info;
let infoMode = 'silent';
console.info = (...args) => { if (infoMode === 'real') realInfo(...args); };

// ---------- pg instrumentation (same for both implementations) ----------
const pg = requirePg();
const stats = { statements: 0, ms: 0, rows: 0, bytes: 0, measureBytes: false };
const originalQuery = pg.Client.prototype.query;
function record(start, result) {
  stats.statements += 1;
  stats.ms += performance.now() - start;
  if (result) {
    stats.rows += result.rowCount ?? result.rows?.length ?? 0;
    if (stats.measureBytes && result.rows) stats.bytes += JSON.stringify(result.rows).length;
  }
}
pg.Client.prototype.query = function instrumentedQuery(...args) {
  const start = performance.now();
  const last = args.at(-1);
  if (typeof last === 'function') {
    args[args.length - 1] = (error, result) => { record(start, result); return last(error, result); };
    return originalQuery.apply(this, args);
  }
  const returned = originalQuery.apply(this, args);
  if (returned && typeof returned.then === 'function') {
    return returned.then((result) => { record(start, result); return result; }, (error) => { record(start, null); throw error; });
  }
  return returned;
};
const instrumented = pg.Client.prototype.query;
const resetStats = (measureBytes = false) => Object.assign(stats, { statements: 0, ms: 0, rows: 0, bytes: 0, measureBytes });

const { prisma } = await importApp('config/prisma.js');
const records = await importApp('controllers/recordsController.js');
const masterList = await importApp('utils/masterCallList.js');
const { validateMasterCallListFilters } = await importApp('utils/masterCallListFilters.js');
const { parsePagination } = await importApp('utils/pagination.js');
const { loadMasterCallListPageTwoPhase } = await import('./master-call-list-prototype.mjs');
const { invalidateCallListCache } = await importApp('utils/callListCache.js');
const client = await openGuardedClient();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const normaliseRole = (role) => String(role || '').toUpperCase();
async function loadUser(username) {
  const user = await prisma.user.findFirst({ where: { OR: [{ id: username }, { username }, { email: username }] }, select: { id: true, name: true, role: true, ccmId: true, username: true, gmId: true, status: true } });
  if (!user) throw new Error(`benchmark user ${username} not found`);
  return user;
}

// ---------- the two implementations behind the same request shape ----------
let nonce = 0;
// The production controller, with the feature flag pinned per call so both paths share one code route.
async function controllerHandler(flagValue, user, query) {
  const previous = process.env.MASTER_CALL_LIST_SQL_ENABLED;
  process.env.MASTER_CALL_LIST_SQL_ENABLED = flagValue;
  try {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await records.getCallList({ user, query: { ...query, _nonce: String(++nonce) } }, res);
    return { code: res.code, body: res.body };
  } finally {
    if (previous === undefined) delete process.env.MASTER_CALL_LIST_SQL_ENABLED; else process.env.MASTER_CALL_LIST_SQL_ENABLED = previous;
  }
}
const oldHandler = (user, query) => controllerHandler('false', user, query);
const sqlHandler = (user, query) => controllerHandler('true', user, query);
async function newHandler(user, query) {
  if (normaliseRole(user.role) === 'FREE_SERVICE_CRE') return { code: 403, body: null };
  const validated = validateMasterCallListFilters(query);
  if (validated.error) return { code: 400, body: { message: validated.error } };
  const pagination = parsePagination(query);
  if (pagination.error) return { code: 400, body: { message: pagination.error } };
  const now = new Date();
  const result = await loadMasterCallListPageTwoPhase({
    app: { records, masterList, prisma }, queryable: client, user,
    requestedCcmId: ['ADMIN', 'GM'].includes(normaliseRole(user.role)) ? String(query.ccmId || '').trim() : '',
    filters: validated.filters, pagination, now, today: now, options: { timeZone },
  });
  if (result.error) return { code: 403, body: { message: result.error } };
  const { missingIds, ...body } = result;
  return { code: 200, body };
}
const HANDLERS = { old: oldHandler, new: newHandler, sql: sqlHandler };

// ---------- measurement ----------
const pct = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const summarize = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), min: Math.min(...values), max: Math.max(...values) });

async function timedCall(handler, user, query) {
  resetStats();
  const start = performance.now();
  const response = await handler(user, query);
  const handlerMs = performance.now() - start;
  const bytes = Buffer.byteLength(JSON.stringify(response.body ?? null));
  const endToEndMs = performance.now() - start;
  return { response, handlerMs, endToEndMs, dbMs: stats.ms, statements: stats.statements, rows: stats.rows, bytes };
}

async function runScenario(handler, label, user, query, count) {
  const samples = [];
  const first = await timedCall(handler, user, query); // first call of this scenario
  for (let i = 0; i < 3; i += 1) await timedCall(handler, user, query); // warm-up, discarded
  for (let i = 0; i < count; i += 1) samples.push(await timedCall(handler, user, query));
  resetStats(true);
  const volume = await handler(user, query);
  const transferred = { rows: stats.rows, driverBytes: stats.bytes };
  resetStats();
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  await timedCall(handler, user, query);
  histogram.disable();
  return {
    label, status: volume.code,
    first: { handlerMs: first.handlerMs, endToEndMs: first.endToEndMs, statements: first.statements },
    statements: summarize(samples.map((s) => s.statements)),
    dbMs: summarize(samples.map((s) => s.dbMs)),
    handlerMs: summarize(samples.map((s) => s.handlerMs)),
    endToEndMs: summarize(samples.map((s) => s.endToEndMs)),
    appMs: summarize(samples.map((s) => s.handlerMs - s.dbMs)),
    rowsTransferred: transferred.rows, driverBytes: transferred.driverBytes,
    responseBytes: samples[0].bytes, total: volume.body?.total ?? null, returned: volume.body?.records?.length ?? null,
    loopP99Ms: histogram.max / 1e6,
  };
}

async function scenarios() {
  const users = {
    admin: await loadUser('bu_admin'), gm1: await loadUser('bu_gm1'),
    ccm1: await loadUser('bu_ccm1'), ccm3: await loadUser('bu_ccm3'), cre: await loadUser('bu_ccm1_cre1'),
  };
  const sample = await client.query(`SELECT split_part("customerName", ' ', 1) AS term FROM master_call_lists WHERE "ccmId" = 'ccm-bench01' ORDER BY id OFFSET 100 LIMIT 1`);
  const term = sample.rows[0]?.term || 'a';
  const filters = [['default', {}], ['dueCategory=1y', { dueCategory: '1y' }], [`search=${term}`, { search: term }], ['page 3 (offset 100)', { offset: '100' }]];
  const out = [];
  for (const [role, user] of Object.entries(users)) for (const [name, query] of filters) out.push({ label: `${role} ${name}`, user, query: { limit: '50', offset: '0', ...query } });
  return out;
}

async function equalityCheck(list, impl) {
  const results = [];
  for (const scenario of list) {
    const old = await oldHandler(scenario.user, scenario.query);
    const fresh = await (impl === 'sql' ? sqlHandler : newHandler)(scenario.user, scenario.query);
    results.push({ label: scenario.label, equal: JSON.stringify(old) === JSON.stringify(fresh), total: old.body?.total, returned: old.body?.records?.length });
  }
  return results;
}

// ---------- 1143 ms vs ~640 ms experiment ----------
async function experiment() {
  const user = await loadUser('bu_ccm1');
  const query = { limit: '50', offset: '0' };
  const runVariant = async (label, setup, teardown, withMemoryProbe = true) => {
    setup?.();
    const times = [];
    for (let i = 0; i < iterations; i += 1) {
      invalidateCallListCache();
      const start = performance.now();
      const res = await oldHandler(user, query);
      JSON.stringify(res.body);
      times.push(performance.now() - start);
    }
    teardown?.();
    return { label, ...summarize(times), withMemoryProbe };
  };
  const realMemoryUsage = process.memoryUsage;
  const results = [];
  results.push(await runVariant('A silent console.info (baseline)', () => { infoMode = 'silent'; }));
  results.push(await runVariant('B console.info to real stdout', () => { infoMode = 'real'; }, () => { infoMode = 'silent'; }));
  results.push(await runVariant('C silent + stubbed process.memoryUsage', () => {
    const stub = () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
    stub.rss = () => 0;
    process.memoryUsage = stub;
  }, () => { process.memoryUsage = realMemoryUsage; }, false));
  results.push(await runVariant('D silent + event-loop monitor on', () => { globalThis.__h = monitorEventLoopDelay({ resolution: 5 }); globalThis.__h.enable(); }, () => globalThis.__h.disable()));
  results.push(await runVariant('E silent (repeat of A, order effect)', () => { infoMode = 'silent'; }));
  results.push(await runVariant('F real stdout + stubbed memoryUsage', () => {
    infoMode = 'real';
    const stub = () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
    stub.rss = () => 0;
    process.memoryUsage = stub;
  }, () => { infoMode = 'silent'; process.memoryUsage = realMemoryUsage; }, false));
  results.push(await runVariant('G silent, pg instrumentation REMOVED', () => { pg.Client.prototype.query = originalQuery; }, () => { pg.Client.prototype.query = instrumented; }, false));
  // Isolate the memory-probe call cost directly.
  const probeStart = performance.now();
  for (let i = 0; i < 1000; i += 1) process.memoryUsage();
  const probeMs = performance.now() - probeStart;
  const rssStart = performance.now();
  for (let i = 0; i < 1000; i += 1) process.memoryUsage.rss();
  const rssMs = performance.now() - rssStart;
  return { results, memoryUsageCostPer1000CallsMs: probeMs, memoryUsageRssCostPer1000CallsMs: rssMs };
}

const startedAt = new Date().toISOString();
let payload;
if (argv.includes('--experiment')) {
  payload = { mode: 'experiment', startedAt, node: process.version, timeZone, ...(await experiment()) };
} else {
  const impl = flag('--impl');
  if (!HANDLERS[impl]) throw new Error('--impl old|new|sql is required');
  const list = await scenarios();
  const equality = impl === 'new' || impl === 'sql' ? await equalityCheck(list, impl) : null;
  const rows = [];
  for (const scenario of list) {
    const row = await runScenario(HANDLERS[impl], scenario.label, scenario.user, scenario.query, iterations);
    rows.push(row);
    console.log(`${impl} | ${row.label.padEnd(30)} stmts=${row.statements.p50} db p50=${row.dbMs.p50.toFixed(1)} handler p50=${row.handlerMs.p50.toFixed(1)} p95=${row.handlerMs.p95.toFixed(1)} p99=${row.handlerMs.p99.toFixed(1)} rows=${row.rowsTransferred} resp=${row.responseBytes}`);
  }
  payload = { mode: 'compare', impl, startedAt, node: process.version, timeZone, iterations, equality, rows };
}
if (outFile) writeFileSync(outFile, JSON.stringify(payload, null, 2));
if (payload.mode === 'experiment') console.log(JSON.stringify(payload, null, 2));
if (payload.equality) console.log('response equality old vs new:', payload.equality.map((e) => `${e.label}:${e.equal ? 'same' : 'DIFF'}`).join(', '));
await client.end();
process.exit(0);
