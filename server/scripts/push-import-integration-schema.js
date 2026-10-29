import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureTestDatabaseUrl } from '../tests/integration/testDatabaseConfig.js';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = path.join(serverDirectory, 'node_modules', 'prisma', 'build', 'index.js');

let databaseUrl;
try {
  databaseUrl = configureTestDatabaseUrl(process.env.TEST_DATABASE_URL);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const child = spawn(process.execPath, [prismaCli, 'db', 'push'], {
  cwd: serverDirectory,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
  },
  shell: false,
  stdio: ['inherit', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

function redactDatabaseUrls(output) {
  return output
    .replaceAll(databaseUrl, '[redacted database URL]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '[redacted database URL]');
}

child.on('error', (error) => {
  console.error('Could not start Prisma schema push.', error.message);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  if (stdout) process.stdout.write(redactDatabaseUrls(stdout));
  if (stderr) process.stderr.write(redactDatabaseUrls(stderr));
  if (signal) {
    console.error(`Prisma schema push stopped by signal ${signal}.`);
    process.exitCode = 1;
  } else if (code !== 0) {
    process.exitCode = code ?? 1;
  }
});
