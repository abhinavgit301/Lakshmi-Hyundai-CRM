// Read-only endpoint benchmark. Calls controller handlers in-process (no HTTP) against a NON-PRODUCTION database.
//
// Usage (from server/):  node scripts/bench-endpoints.mjs [--iterations 20] [--out results.json]
//
// Safety, all enforced before any controller is imported:
//   - connection comes only from server/.env.bench (gitignored); server/.env is never read by this script
//   - host must be localhost/127.0.0.1 and the database name must be exactly "lakshmi_hyundai_crm_bench"
//   - sessions are forced read-only (default_transaction_read_only=on) and re-checked with SHOW
//   - only GET handlers are called; credentials are never printed
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchEnvPath = path.join(serverDir, '.env.bench');

function fail(message) {
  console.error(`bench: refusing to run - ${message}`);
  process.exit(2);
}

function parseEnvFile(file) {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || match[1].startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function args() {
  const options = { iterations: 20, out: null };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--iterations') options.iterations = Number(argv[++index]);
    else if (argv[index] === '--out') options.out = argv[++index];
    else fail(`unknown argument ${argv[index]}`);
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 3 || options.iterations > 500) fail('--iterations must be 3-500');
  return options;
}

function guardConnection() {
  if (!existsSync(benchEnvPath)) fail('server/.env.bench does not exist (create it with DATABASE_URL for a *_bench database)');
  const bench = parseEnvFile(benchEnvPath);
  if (!bench.DATABASE_URL) fail('server/.env.bench has no DATABASE_URL');
  let url;
  try { url = new URL(bench.DATABASE_URL); } catch { fail('DATABASE_URL in .env.bench is not a valid URL'); }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (dbName !== 'lakshmi_hyundai_crm_bench') fail('database name must be exactly "lakshmi_hyundai_crm_bench"');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) fail('host must be localhost or 127.0.0.1');
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  process.env.DATABASE_URL = url.toString();
  return { dbName, host: url.hostname };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

function fakeRes() {
  const res = {
    statusCode: 200,
    locals: {},
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

async function time(handler, req) {
  const res = fakeRes();
  const start = performance.now();
  await handler(req, res);
  return { ms: performance.now() - start, status: res.statusCode, bytes: Buffer.byteLength(JSON.stringify(res.body ?? null)) };
}

async function measure(label, iterations, run, beforeEach = () => {}) {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const samples = [];
  let last;
  for (let index = 0; index < iterations; index += 1) {
    beforeEach();
    last = await run();
    samples.push(last.ms);
  }
  histogram.disable();
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    label,
    status: last.status,
    bytes: last.bytes,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    loopP99: histogram.percentile(99) / 1e6,
  };
}

async function main() {
  const { iterations, out } = args();
  const { dbName, host } = guardConnection();

  const { prisma } = await import(pathToFileURL(path.join(serverDir, 'src/config/prisma.js')));
  const [{ database }] = await prisma.$queryRaw`SELECT current_database() AS database`;
  const [{ read_only: readOnly }] = await prisma.$queryRaw`SELECT current_setting('default_transaction_read_only') AS read_only`;
  if (database !== dbName || !/_bench$/i.test(database)) fail('connected database does not match the allow-list');
  if (readOnly !== 'on') fail('session is not read-only');
  console.log(`bench: database=${database} host=${host} read-only=on iterations=${iterations}`);

  const records = await import(pathToFileURL(path.join(serverDir, 'src/controllers/recordsController.js')));
  const lists = await import(pathToFileURL(path.join(serverDir, 'src/controllers/serviceListsController.js')));
  const workflow = await import(pathToFileURL(path.join(serverDir, 'src/controllers/callWorkflowController.js')));
  const { invalidateCallListCache } = await import(pathToFileURL(path.join(serverDir, 'src/utils/callListCache.js')));
  const { loadAuthUser, resetAuthCacheForTests } = await import(pathToFileURL(path.join(serverDir, 'src/utils/authUserCache.js')));

  const pick = async (role) => prisma.user.findFirst({ where: { role, status: 'active' }, orderBy: { createdAt: 'asc' } });
  const users = { ADMIN: await pick('ADMIN'), GM: await pick('GM'), CCM: await pick('CCM'), CRE: await pick('CRE') };
  const asUser = (row) => (row ? { ...row, role: row.role === 'ADMIN' ? 'Admin' : row.role } : null);
  const today = new Date().toISOString().slice(0, 10);
  const [year, month] = today.split('-').map(Number);

  const cases = [
    ['CCM  GET /call-list?limit=50', 'CCM', records.getCallList, { limit: '50', offset: '0' }],
    ['CRE  GET /call-list?limit=50', 'CRE', records.getCallList, { limit: '50', offset: '0' }],
    ['CRE  GET /call-list/due 1y', 'CRE', records.getDueCallList, { window: '1y', limit: '50' }],
    ['CRE  GET /call-list/due 6m', 'CRE', records.getDueCallList, { window: '6m', limit: '50' }],
    ['CRE  GET /free-service', 'CRE', lists.getFreeServiceList, { limit: '50', offset: '0' }],
    ['CRE  GET /warranty', 'CRE', lists.getWarrantyList, { limit: '50', offset: '0' }],
    ['CRE  GET /dashboard/summary', 'CRE', records.getDashboardSummary, {}],
    ['CCM  GET /dashboard/summary', 'CCM', records.getDashboardSummary, {}],
    ['GM   GET /dashboard/summary', 'GM', records.getDashboardSummary, {}],
    ['CRE  GET /cre/performance', 'CRE', workflow.getCrePerformanceSummary, { year: String(year), month: String(month), date: today }],
    ['CCM  GET /customers?limit=50', 'CCM', records.getCustomers, { limit: '50', offset: '0' }],
    ['CCM  GET /customers picker search', 'CCM', records.getCustomers, { limit: '50', offset: '0', fields: 'picker', search: 'a' }],
    ['CCM  GET /appointments?limit=50', 'CCM', records.getAppointments, { limit: '50', offset: '0' }],
    ['CCM  GET /appointments (unpaginated)', 'CCM', records.getAppointments, {}],
  ];

  const results = [];
  for (const [label, role, handler, query] of cases) {
    const user = asUser(users[role]);
    if (!user) { console.log(`bench: skip "${label}" (no active ${role} user)`); continue; }
    const request = () => ({ user, query, params: {}, headers: {} });
    await time(handler, request()); // warm connections and JIT
    results.push(await measure(`${label} [cold]`, iterations, () => time(handler, request()), () => invalidateCallListCache()));
    invalidateCallListCache();
    results.push(await measure(`${label} [cached]`, iterations, () => time(handler, request())));
  }

  const authUser = users.CRE;
  if (authUser) {
    const lookup = async () => {
      const start = performance.now();
      await prisma.user.findUnique({ where: { id: authUser.id } });
      return { ms: performance.now() - start, status: 200, bytes: 0 };
    };
    results.push(await measure('auth lookup, no cache', iterations * 5, lookup));
    process.env.AUTH_CACHE_TTL_SECONDS = '3';
    resetAuthCacheForTests();
    const cachedLookup = async () => {
      const start = performance.now();
      await loadAuthUser(authUser.id, () => prisma.user.findUnique({ where: { id: authUser.id } }));
      return { ms: performance.now() - start, status: 200, bytes: 0 };
    };
    results.push(await measure('auth lookup, 3s cache', iterations * 5, cachedLookup));
  }

  const pad = (value, width) => String(value).padEnd(width);
  console.log(`\n${pad('case', 46)}${pad('status', 8)}${pad('bytes', 10)}${pad('p50 ms', 9)}${pad('p95 ms', 9)}${pad('p99 ms', 9)}${pad('loop p99', 9)}`);
  for (const row of results) {
    console.log(`${pad(row.label, 46)}${pad(row.status, 8)}${pad(row.bytes, 10)}${pad(row.p50.toFixed(1), 9)}${pad(row.p95.toFixed(1), 9)}${pad(row.p99.toFixed(1), 9)}${pad(row.loopP99.toFixed(1), 9)}`);
  }
  if (out) writeFileSync(path.resolve(out), JSON.stringify({ database, iterations, results }, null, 2));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('bench: failed -', error.message);
  process.exit(1);
});
