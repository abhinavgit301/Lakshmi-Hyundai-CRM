import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const isWindows = process.platform === 'win32';
const recoveryScript = path.resolve('deploy/recover-release.sh');
const releaseId = 'a'.repeat(40);

function executable(filePath, contents) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

async function withRecoveryFixture(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lhcrm-recovery-'));
  const appRoot = path.join(root, 'app');
  const releases = path.join(appRoot, 'releases');
  const incoming = path.join(appRoot, 'incoming');
  const mockBin = path.join(root, 'bin');
  const oldRelease = path.join(releases, 'initial');
  const candidate = path.join(releases, releaseId);
  const controlLog = path.join(root, 'control.log');
  mkdirSync(path.join(oldRelease, 'server', 'src'), { recursive: true });
  mkdirSync(path.join(oldRelease, 'client', 'dist'), { recursive: true });
  mkdirSync(path.join(candidate, 'server', 'src'), { recursive: true });
  mkdirSync(path.join(candidate, 'client', 'dist'), { recursive: true });
  mkdirSync(incoming, { recursive: true });
  mkdirSync(mockBin);
  writeFileSync(path.join(oldRelease, 'server', 'src', 'server.js'), 'old');
  writeFileSync(path.join(oldRelease, 'client', 'dist', 'index.html'), 'old');
  writeFileSync(path.join(candidate, 'server', 'src', 'server.js'), 'new');
  writeFileSync(path.join(candidate, 'client', 'dist', 'index.html'), 'new');
  symlinkSync(oldRelease, path.join(appRoot, 'current'), 'dir');
  symlinkSync(oldRelease, path.join(releases, 'previous'), 'dir');

  executable(path.join(mockBin, 'id'), '#!/bin/sh\nprintf "lakshmi-deploy\\n"\n');
  executable(path.join(mockBin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n');
  executable(path.join(mockBin, 'curl'), '#!/bin/sh\n[ "${LHCRM_FAIL_HEALTH:-false}" != true ]\n');
  executable(path.join(root, 'control'), `#!/bin/sh
printf '%s\\n' "$*" >> "$LHCRM_CONTROL_LOG"
case "$1" in
    activate-release)
      target="$LHCRM_RELEASES/$2"
      temporary="$LHCRM_CURRENT.next"
      ln -s "$target" "$temporary"
      mv -Tf "$temporary" "$LHCRM_CURRENT"
      ;;
    restart-backend) [ "\${LHCRM_FAIL_RESTART:-false}" != true ] ;;
    reload-nginx) true ;;
  backend-active) [ "\${LHCRM_FAIL_ACTIVE:-false}" != true ] ;;
  startup-check) [ "\${LHCRM_FAIL_STARTUP:-false}" != true ] ;;
  *) exit 2 ;;
esac
`);

  const scriptCopy = path.join(root, 'recover-release.sh');
  const original = readFileSync(recoveryScript, 'utf8');
  const replaced = original
    .replace('readonly APP_ROOT=/opt/lakshmi-hyundai', `readonly APP_ROOT='${appRoot}'`)
    .replace('readonly CONTROL=/usr/local/sbin/lakshmi-hyundai-deploy-control', `readonly CONTROL='${path.join(root, 'control')}'`)
    .replace('readonly FRONTEND_HOST=lakshmi-hyundai-crm.tech', 'readonly FRONTEND_HOST=local.test')
    .replace('if ! flock -w 3300 9; then', 'if ! flock -w 10 9; then');
  writeFileSync(scriptCopy, replaced);

  const run = (phase, current = candidate, overrides = {}) => {
    symlinkSync(current, path.join(appRoot, 'current.next'), 'dir');
    // Replace the pointer atomically in the isolated fixture.
    const pointer = path.join(appRoot, 'current.next');
    const currentLink = path.join(appRoot, 'current');
    renameSync(pointer, currentLink);
    writeFileSync(
      path.join(releases, '.deployment-state'),
      `${releaseId}\t${oldRelease}\t${candidate}\t${phase}\n`,
    );
    writeFileSync(controlLog, '');
    const started = Date.now();
    const result = spawnSync('bash', [scriptCopy, releaseId], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${mockBin}${path.delimiter}${process.env.PATH}`,
        LHCRM_CONTROL_LOG: controlLog,
        LHCRM_CURRENT: path.join(appRoot, 'current'),
        LHCRM_RELEASES: releases,
        ...overrides,
      },
      timeout: 20_000,
    });
    return {
      ...result,
      elapsed: Date.now() - started,
      active: realpathSync(path.join(appRoot, 'current')),
      prior: realpathSync(path.join(releases, 'previous')),
      stateExists: existsSync(path.join(releases, '.deployment-state')),
      controlLog: readFileSync(controlLog, 'utf8'),
      oldRelease,
      candidate,
      releases,
      appRoot,
      scriptCopy,
    };
  };

  try {
    await callback({ run, root, releases, oldRelease, candidate, appRoot, controlLog });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('recovers interrupted post-migration activation, checks health, and is idempotent', { skip: isWindows }, async () => {
  await withRecoveryFixture(({ run, oldRelease, candidate }) => {
    const recovery = run('migration-applied');
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(recovery.active, oldRelease);
    assert.equal(recovery.prior, candidate);
    assert.equal(recovery.stateExists, false);
    assert.match(recovery.controlLog, /restart-backend/);
    assert.match(recovery.controlLog, /startup-check/);
    assert.match(recovery.stderr, /never rolls back the database schema/);

    const repeated = spawnSync('bash', [recovery.scriptCopy, releaseId], {
      cwd: recovery.appRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(path.dirname(recovery.scriptCopy), 'bin')}${path.delimiter}${process.env.PATH}` },
      timeout: 20_000,
    });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /nothing to recover/);
  });
});

test('clears a pre-activation attempt without restarting the backend', { skip: isWindows }, async () => {
  await withRecoveryFixture(({ run, oldRelease, controlLog }) => {
    const recovery = run('prepared', oldRelease);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(recovery.active, oldRelease);
    assert.equal(recovery.stateExists, false);
    assert.equal(controlLog ? readFileSync(controlLog, 'utf8') : '', '');
  });
});

test('removes only the interrupted attempt staging directory during pre-activation recovery', { skip: isWindows }, async () => {
  await withRecoveryFixture(({ run, oldRelease, releases }) => {
    const stage = path.join(releases, `.staging-${releaseId}`);
    mkdirSync(stage);
    writeFileSync(path.join(stage, 'partial'), 'incomplete');
    const recovery = run('started', oldRelease);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(recovery.active, oldRelease);
    assert.equal(existsSync(stage), false);
    assert.equal(recovery.stateExists, false);
  });
});

for (const [label, failure] of [
  ['backend restart', { LHCRM_FAIL_RESTART: 'true' }],
  ['backend active check', { LHCRM_FAIL_ACTIVE: 'true' }],
  ['local health check', { LHCRM_FAIL_HEALTH: 'true' }],
  ['startup log check', { LHCRM_FAIL_STARTUP: 'true' }],
]) {
  test(`retains recovery state when ${label} fails`, { skip: isWindows }, async () => {
    await withRecoveryFixture(({ run, oldRelease }) => {
      const recovery = run('migration-applied', undefined, failure);
      assert.notEqual(recovery.status, 0);
      assert.equal(recovery.active, oldRelease);
      assert.equal(recovery.stateExists, true);
      assert.match(recovery.stderr, /Recovery restored the previous pointer/);
    });
  });
}

test('waits for the deployment lock before recovering an uncertain SSH outcome', { skip: isWindows }, async () => {
  await withRecoveryFixture(({ run, releases, oldRelease }) => new Promise((resolve, reject) => {
    const lockFile = path.join(releases, '.deploy.lock');
    const holder = spawn('flock', ['-x', lockFile, 'sleep', '0.4'], { stdio: 'ignore' });
    holder.once('error', reject);
    holder.once('spawn', async () => {
      try {
        await delay(80);
        const recovery = run('activating');
        assert.equal(recovery.status, 0, recovery.stderr);
        assert.equal(recovery.active, oldRelease);
        assert.ok(recovery.elapsed >= 250, `recovery raced the lock (${recovery.elapsed} ms)`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }));
});
