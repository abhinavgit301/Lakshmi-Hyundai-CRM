import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const snapshotsOnly = args[0] === '--snapshots';
if (snapshotsOnly) args.shift();
const serial = snapshotsOnly || Boolean(process.env.SNAPSHOT_INTEGRATION_DATABASE_URL);

if (snapshotsOnly && !process.env.SNAPSHOT_INTEGRATION_DATABASE_URL) {
  throw new Error('Set SNAPSHOT_INTEGRATION_DATABASE_URL to a disposable local snapshot test database.');
}
if (serial && args.some((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='))) {
  throw new Error('Snapshot integration tests require --test-concurrency=1; do not override it.');
}

const files = snapshotsOnly
  ? readdirSync(path.join(serverDirectory, 'tests'))
    .filter((name) => /^snapshot.*\.integration\.test\.js$/.test(name))
    .sort()
    .map((name) => path.join(serverDirectory, 'tests', name))
  : [];
if (snapshotsOnly && !files.length) throw new Error('No snapshot integration tests were found.');

const result = spawnSync(process.execPath, [
  ...(snapshotsOnly ? ['--expose-gc'] : []),
  '--import', 'dotenv/config', '--test',
  ...(serial ? ['--test-concurrency=1'] : []),
  ...args, ...files,
], { cwd: serverDirectory, stdio: 'inherit', env: process.env });

if (result.error) {
  console.error('Could not start backend tests:', result.error);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`Backend tests stopped by signal ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
