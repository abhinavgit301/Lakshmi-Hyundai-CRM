// Shared safety layer for the performance-aggregate scripts (backfill, reconcile, repair).
//
// Targets: the connection string is read ONLY from an env file, never from process.env and never from
// server/.env. The default is server/.env.bench, which must point at localhost and the exact benchmark
// database. Anything else needs --env-file, --expect-db, --allow-non-bench and
// PERFORMANCE_SCRIPTS_ALLOW_NON_BENCH=yes; a write to such a target additionally needs --confirm "<db>@<host>".
// The identity of the live session (database, host, port, user, server version) is printed and verified
// before any other statement runs. Credentials are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BENCH_DB = 'lakshmi_hyundai_crm_bench';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export function fail(message) {
  console.error(`performance-scripts: refusing to run - ${message}`);
  process.exit(2);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { flags: new Set(), values: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`unexpected argument ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (inline !== undefined) args.values[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) { args.values[name] = argv[index + 1]; index += 1; } else args.flags.add(name);
  }
  return args;
}

export function readDatabaseUrl(envFile) {
  if (!existsSync(envFile)) fail(`${envFile} does not exist`);
  const variable = path.basename(envFile) === '.env.bench.seed' ? 'BENCH_SEED_DATABASE_URL' : 'DATABASE_URL';
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((entry) => new RegExp(`^\\s*${variable}\\s*=`).test(entry));
  if (!line) fail(`${envFile} has no ${variable}`);
  try {
    return new URL(line.replace(new RegExp(`^\\s*${variable}\\s*=\\s*`), '').replace(/^(['"])(.*)\1$/, '$2'));
  } catch {
    return fail(`${variable} is not a valid URL`);
  }
}

// Returns the validated target. `write` selects a writable session; otherwise the session is read-only.
export function resolveTarget(args, { write }) {
  const requested = args.values['env-file'];
  const envFile = requested ? path.resolve(requested) : path.join(serverDir, '.env.bench');
  if (path.basename(envFile) === '.env') fail('server/.env is never used by these scripts');
  const url = readDatabaseUrl(envFile);
  const host = url.hostname;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const isBench = LOCAL_HOSTS.includes(host) && database === BENCH_DB;

  if (!isBench) {
    if (!args.flags.has('allow-non-bench') || process.env.PERFORMANCE_SCRIPTS_ALLOW_NON_BENCH !== 'yes') {
      fail(`target ${database}@${host} is not the benchmark database; this needs --allow-non-bench and PERFORMANCE_SCRIPTS_ALLOW_NON_BENCH=yes`);
    }
    if (args.values['expect-db'] !== database) fail(`--expect-db must equal the target database name (${database})`);
    if (write && args.values.confirm !== `${database}@${host}`) fail(`writing needs --confirm "${database}@${host}"`);
  }
  if (!write) url.searchParams.set('options', '-c default_transaction_read_only=on');
  return { url, host, port: url.port || '5432', database, isBench, envFile };
}

export function requirePg() {
  return createRequire(path.join(serverDir, 'package.json'))('pg');
}

// Connects, prints the session identity and verifies it. Returns the pg client.
export async function openVerifiedClient(target, { write, requireTables = true }) {
  const pg = requirePg();
  const client = new pg.Client({ connectionString: target.url.toString() });
  await client.connect();
  const { rows } = await client.query(`
    SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port,
           current_setting('server_version') AS version, current_setting('default_transaction_read_only') AS ro,
           current_setting('TimeZone') AS tz`);
  const identity = rows[0];
  console.log(`Database identity: ${JSON.stringify({ database: identity.db, user: identity.usr, host: target.host, serverAddress: identity.addr, port: identity.port, version: identity.version, mode: write ? 'WRITE' : 'READ-ONLY', sessionReadOnly: identity.ro, bench: target.isBench })}`);
  if (identity.db !== target.database) { await client.end(); fail(`connected to ${identity.db}, expected ${target.database}`); }
  if (!write && identity.ro !== 'on') { await client.end(); fail('read-only session was not enforced'); }
  const { rows: tables } = await client.query(
    "SELECT to_regclass('public.cre_call_daily') AS daily, to_regclass('public.cre_performance_snapshots') AS snaps",
  );
  if (requireTables && (!tables[0].daily || !tables[0].snaps)) {
    await client.end();
    fail('the performance aggregate tables do not exist in this database (the migration has not been applied here)');
  }
  return client;
}

// Points the application's Prisma client at the verified target, then loads it.
export async function loadPrisma(target, { write }) {
  const url = new URL(target.url.toString());
  if (!write) url.searchParams.set('options', '-c default_transaction_read_only=on');
  process.env.DATABASE_URL = url.toString();
  const { prisma } = await import(pathToFileURL(path.join(serverDir, 'src', 'config', 'prisma.js')).href);
  const [{ db }] = await prisma.$queryRaw`SELECT current_database() AS db`;
  if (db !== target.database) fail(`Prisma connected to ${db}, expected ${target.database}`);
  return prisma;
}

export async function startScript(name, { write, requireTables = true }) {
  const args = parseArgs();
  const target = resolveTarget(args, { write });
  console.log(`${name}: ${write ? 'WRITE-CAPABLE' : 'READ-ONLY'} run, env file ${path.basename(target.envFile)}`);
  const client = await openVerifiedClient(target, { write, requireTables });
  await client.end();
  const prisma = await loadPrisma(target, { write });
  return { args, target, prisma };
}
