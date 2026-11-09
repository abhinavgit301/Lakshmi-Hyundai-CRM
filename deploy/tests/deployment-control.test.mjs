import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const isWindows = process.platform === 'win32';
const releaseId = 'a'.repeat(40);
const controlSource = path.resolve('deploy/lakshmi-hyundai-deploy-control');

function fixture(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lhcrm-control-'));
  const appRoot = path.join(root, 'app');
  const releases = path.join(appRoot, 'releases');
  const incoming = path.join(appRoot, 'incoming');
  const release = path.join(releases, releaseId);
  const binary = path.join(root, 'lakshmi-hyundai-deploy-control');
  mkdirSync(path.join(release, 'server', 'deploy'), { recursive: true });
  mkdirSync(path.join(release, 'server', 'prisma'), { recursive: true });
  mkdirSync(path.join(release, 'server', 'node_modules', 'prisma', 'build'), { recursive: true });
  mkdirSync(path.join(release, 'client', 'dist'), { recursive: true });
  mkdirSync(incoming, { recursive: true });
  writeFileSync(path.join(release, 'server', 'deploy', 'check-prisma-migrations.mjs'), 'export {};\n');
  writeFileSync(path.join(release, 'server', 'prisma', 'schema.prisma'), 'datasource db {}\n');
  writeFileSync(path.join(release, 'server', 'node_modules', 'prisma', 'build', 'index.js'), 'process.exit(0);\n');
  writeFileSync(path.join(release, 'client', 'dist', 'index.html'), '<html></html>\n');
  writeFileSync(path.join(release, 'RELEASE_COMMIT'), `${'a'.repeat(40)}\n`);
  chmodSync(release, 0o755);
  const source = readFileSync(controlSource, 'utf8')
    .replace('if [[ ${EUID:-$(id -u)} -ne 0 ]]; then', 'if false; then')
    .replaceAll('/opt/lakshmi-hyundai', appRoot)
    .replace(
      '"$(/usr/bin/stat -c %u -- "$release")" == 0',
      '"$(/usr/bin/stat -c %u -- "$release")" == "$(/usr/bin/id -u)"',
    );
  writeFileSync(binary, source);

  try {
    callback({ binary, appRoot, releases, incoming, release });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('direct migration helper invocation without a signed token is rejected', { skip: isWindows }, () => {
  fixture(({ binary }) => {
    const result = spawnSync('bash', [binary, 'migrate-deploy', releaseId], {
      encoding: 'utf8',
      env: { ...process.env, SUDO_USER: 'lakshmi-deploy' },
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signed, release-specific migration authorization is required/);
  });
});

test('migration helper rejects invalid IDs and symlink redirection', { skip: isWindows }, () => {
  fixture(({ binary, releases, release }) => {
    const invalid = spawnSync('bash', [binary, 'migrate-deploy', '../outside'], {
      encoding: 'utf8',
      env: { ...process.env, SUDO_USER: 'lakshmi-deploy' },
      timeout: 10_000,
    });
    assert.equal(invalid.status, 2);

    const outside = path.join(path.dirname(releases), 'outside');
    mkdirSync(outside);
    rmSync(release, { recursive: true, force: true });
    symlinkSync(outside, release, 'dir');
    const redirected = spawnSync('bash', [binary, 'migrate-deploy', releaseId], {
      encoding: 'utf8',
      env: { ...process.env, SUDO_USER: 'lakshmi-deploy' },
      timeout: 10_000,
    });
    assert.notEqual(redirected.status, 0);
    assert.match(redirected.stderr, /Migration release does not exist/);
  });
});
