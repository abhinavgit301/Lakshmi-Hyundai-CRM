import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { configureTestDatabaseUrl } from '../tests/integration/testDatabaseConfig.js';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationDirectory = path.join(serverDirectory, 'tests', 'integration');
const databaseUrl = configureTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const testFiles = (await readdir(integrationDirectory))
  .filter((fileName) => fileName.endsWith('.integration.js'))
  .sort()
  .map((fileName) => path.join(integrationDirectory, fileName));

if (testFiles.length === 0) {
  throw new Error('No PostgreSQL integration test files were found.');
}

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: serverDirectory,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
  },
  stdio: 'inherit',
  shell: false,
});

child.on('error', (error) => {
  console.error('Could not start the PostgreSQL integration tests.', error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`PostgreSQL integration tests stopped by signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
