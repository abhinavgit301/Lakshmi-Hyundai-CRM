import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getSchemaMutationError(operation, env = process.env) {
  if (!['push', 'reset'].includes(operation)) {
    return `Unsupported Prisma schema mutation: ${operation}`;
  }
  if (env.NODE_ENV === 'production') {
    return 'Prisma schema mutations are disabled when NODE_ENV=production.';
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL || '');
  } catch {
    return 'DATABASE_URL must be a valid PostgreSQL URL.';
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !localHosts.has(databaseUrl.hostname.toLowerCase())) {
    return 'Prisma schema mutations are allowed only for a loopback PostgreSQL database.';
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  } catch {
    return 'DATABASE_URL must contain a valid database name.';
  }

  const isApprovedCiPush = operation === 'push'
    && env.CI === 'true'
    && env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_REPOSITORY === 'abhinavgit301/Lakshmi-Hyundai-CRM'
    && env.GITHUB_WORKFLOW === 'CI and controlled production deployment'
    && env.GITHUB_WORKFLOW_REF === 'abhinavgit301/Lakshmi-Hyundai-CRM/.github/workflows/deploy.yml@refs/heads/main'
    && env.NODE_ENV === 'test'
    && databaseUrl.protocol === 'postgresql:'
    && databaseUrl.hostname === '127.0.0.1'
    && databaseUrl.port === '5432'
    && databaseUrl.username === 'ci'
    && databaseName === 'status_test_ci'
    && databaseUrl.searchParams.size === 1
    && databaseUrl.searchParams.get('schema') === 'public'
    && !databaseUrl.hash;
  if (isApprovedCiPush) return null;

  if (env.ALLOW_LOCAL_PRISMA_SCHEMA_MUTATION !== 'true') {
    return 'Set ALLOW_LOCAL_PRISMA_SCHEMA_MUTATION=true only for an approved disposable local database.';
  }

  const allowedDatabase = operation === 'reset'
    ? /_test$/i.test(databaseName)
    : /_(dev|test)$/i.test(databaseName);
  if (!allowedDatabase) {
    return operation === 'reset'
      ? 'Prisma reset is allowed only for a local database whose name ends in _test.'
      : 'Prisma db push is allowed only for a local database whose name ends in _dev or _test.';
  }

  return null;
}

export function getPrismaSchemaMutationOperation(argv) {
  const command = argv.slice(2);
  const dbIndex = command.findIndex((arg) => arg === 'db');
  if (dbIndex < 0) return null;
  const dbArgs = command.slice(dbIndex + 1);
  if (dbArgs.includes('push')) return dbArgs.includes('--force-reset') ? 'reset' : 'push';
  return null;
}

function runCli() {
  const operation = process.argv[2];
  const error = getSchemaMutationError(operation);
  if (error) {
    console.error(`Refusing Prisma schema mutation: ${error}`);
    process.exitCode = 1;
  } else {
    const prismaCli = path.join(serverDirectory, 'node_modules', 'prisma', 'build', 'index.js');
    const args = [prismaCli, 'db', 'push'];
    if (operation === 'reset') args.push('--force-reset');
    const result = spawnSync(process.execPath, args, {
      cwd: serverDirectory,
      env: process.env,
      stdio: 'inherit',
    });

    if (result.error) {
      console.error('Could not start Prisma schema mutation:', result.error);
      process.exitCode = 1;
    } else if (result.signal) {
      console.error(`Prisma schema mutation stopped by signal ${result.signal}.`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
