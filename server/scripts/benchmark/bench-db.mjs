// Shared, guarded connection helper for the local benchmark scripts.
// Reads ONLY server/.env.bench (never server/.env), requires localhost and the exact benchmark database name,
// and forces every session read-only. Credentials are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BENCH_DB = 'lakshmi_hyundai_crm_bench';

function fail(message) {
  console.error(`bench-db: refusing to run - ${message}`);
  process.exit(2);
}

export function guardedBenchUrl() {
  const file = path.join(serverDir, '.env.bench');
  if (!existsSync(file)) fail('server/.env.bench does not exist');
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((entry) => /^\s*DATABASE_URL\s*=/.test(entry));
  if (!line) fail('server/.env.bench has no DATABASE_URL');
  let url;
  try {
    url = new URL(line.replace(/^\s*DATABASE_URL\s*=\s*/, '').replace(/^(['"])(.*)\1$/, '$2'));
  } catch {
    fail('DATABASE_URL is not a valid URL');
  }
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) fail('host must be localhost or 127.0.0.1');
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== BENCH_DB) fail(`database must be exactly ${BENCH_DB}`);
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  return url.toString();
}

export function configureBenchEnvironment() {
  process.env.DATABASE_URL = guardedBenchUrl();
}

export async function importApp(relativePath) {
  return import(pathToFileURL(path.join(serverDir, 'src', relativePath)).href);
}

export function requirePg() {
  return createRequire(path.join(serverDir, 'package.json'))('pg');
}

export async function openGuardedClient() {
  const pg = requirePg();
  const client = new pg.Client({ connectionString: guardedBenchUrl() });
  await client.connect();
  const { rows } = await client.query(
    "SELECT current_database() AS db, current_setting('default_transaction_read_only') AS ro",
  );
  if (rows[0].db !== BENCH_DB || rows[0].ro !== 'on') {
    await client.end();
    fail('connected session failed the database/read-only check');
  }
  return client;
}
