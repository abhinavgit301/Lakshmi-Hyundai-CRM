// Phase 4 benchmark: old vs SQL-backed Master Call List under sequential and concurrent load.
// Local benchmark database only (guarded read-only connection via bench-db.mjs). Writes only the JSON result file.
//
//   node scripts/benchmark/master-call-list-concurrency.mjs --impl old|sql [--samples 20] [--requests 60] [--levels 1,5,10] [--out file.json]
// The feature flag is pinned once per process (not per request) so concurrent requests cannot race on it.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { configureBenchEnvironment, importApp, requirePg } from './bench-db.mjs';

configureBenchEnvironment();
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const impl = flag('--impl');
if (!['old', 'sql'].includes(impl)) throw new Error('--impl old|sql is required');
const samples = Number(flag('--samples', 20));
const requests = Number(flag('--requests', 60));
const levels = String(flag('--levels', '1,5,10')).split(',').map(Number);
const outFile = flag('--out');
process.env.MASTER_CALL_LIST_SQL_ENABLED = impl === 'sql' ? 'true' : 'false';
console.info = () => {};

const pg = requirePg();
const stats = { statements: 0, ms: 0, rows: 0 };
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function instrumentedQuery(...args) {
  const start = performance.now();
  const done = (result) => { stats.statements += 1; stats.ms += performance.now() - start; stats.rows += result?.rowCount ?? result?.rows?.length ?? 0; };
  const last = args.at(-1);
  if (typeof last === 'function') {
    args[args.length - 1] = (error, result) => { done(result); return last(error, result); };
    return originalQuery.apply(this, args);
  }
  const returned = originalQuery.apply(this, args);
  return returned && typeof returned.then === 'function' ? returned.then((r) => { done(r); return r; }, (e) => { done(null); throw e; }) : returned;
};

const { prisma } = await importApp('config/prisma.js');
const records = await importApp('controllers/recordsController.js');
const loadUser = (username) => prisma.user.findFirst({ where: { OR: [{ id: username }, { username }, { email: username }] }, select: { id: true, name: true, role: true, ccmId: true, username: true, gmId: true, status: true } });
const users = { admin: await loadUser('bu_admin'), ccm1: await loadUser('bu_ccm1'), cre: await loadUser('bu_ccm1_cre1') };
const term = (await prisma.$queryRawUnsafe(`SELECT split_part("customerName", ' ', 1) AS term FROM master_call_lists WHERE "ccmId" = 'ccm-bench01' ORDER BY id OFFSET 100 LIMIT 1`))[0]?.term || 'a';

const SCENARIOS = [
  { label: 'ccm1 default (CCM list; bench has no queue-only rows)', user: users.ccm1, query: {} },
  { label: 'cre default', user: users.cre, query: {} },
  { label: 'admin default', user: users.admin, query: {} },
  { label: 'admin 1y filter', user: users.admin, query: { dueCategory: '1y' } },
  { label: `admin search=${term}`, user: users.admin, query: { search: term } },
  { label: 'admin pastDue filter', user: users.admin, query: { dueCategory: 'pastDue' } },
  { label: 'admin pagination offset=100', user: users.admin, query: { offset: '100' } },
  { label: 'admin pagination offset=2000', user: users.admin, query: { offset: '2000' } },
];

let nonce = 0;
async function call(scenario) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const start = performance.now();
  await records.getCallList({ user: scenario.user, query: { limit: '50', offset: '0', ...scenario.query, _nonce: `${impl}-${++nonce}` } }, res);
  const ms = performance.now() - start;
  if (res.code !== 200) throw new Error(`${scenario.label}: HTTP-equivalent ${res.code}`);
  return ms;
}
const pct = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const summarize = (v) => ({ n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) });

async function sequential(scenario) {
  await call(scenario);
  await call(scenario);
  Object.assign(stats, { statements: 0, ms: 0, rows: 0 });
  const times = [];
  for (let i = 0; i < samples; i += 1) times.push(await call(scenario));
  return { ...summarize(times), stmtsPerReq: stats.statements / samples, rowsPerReq: stats.rows / samples, dbMsPerReq: stats.ms / samples };
}

async function concurrent(scenario, level) {
  Object.assign(stats, { statements: 0, ms: 0, rows: 0 });
  const times = [];
  let issued = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: level }, async () => {
    while (issued < requests) { issued += 1; times.push(await call(scenario)); }
  }));
  const wall = performance.now() - start;
  return { level, ...summarize(times), wallMs: wall, throughputRps: (times.length / wall) * 1000, stmtsPerReq: stats.statements / times.length };
}

const rows = [];
for (const scenario of SCENARIOS) {
  const seq = await sequential(scenario);
  const conc = [];
  for (const level of levels) conc.push(await concurrent(scenario, level));
  rows.push({ label: scenario.label, sequential: seq, concurrent: conc });
  console.log(`${impl} | ${scenario.label.padEnd(54)} seq p50=${seq.p50.toFixed(0)} p95=${seq.p95.toFixed(0)} max=${seq.max.toFixed(0)} stmts=${seq.stmtsPerReq} rows=${seq.rowsPerReq} | ${conc.map((c) => `c${c.level}: p50=${c.p50.toFixed(0)} p95=${c.p95.toFixed(0)} max=${c.max.toFixed(0)} ${c.throughputRps.toFixed(1)}rps`).join(' | ')}`);
}
if (outFile) writeFileSync(outFile, JSON.stringify({ impl, startedAt: new Date().toISOString(), node: process.version, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, samples, requests, levels, rows }, null, 2));
process.exit(0);
