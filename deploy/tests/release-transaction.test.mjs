import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeArchive, requiredFiles } from './archive-fixtures.mjs';

const isWindows = process.platform === 'win32';
const commitSha = 'a'.repeat(40);
const releaseId = commitSha;

function executable(filePath, contents) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function withFixture(callback, archiveEntries = requiredFiles) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lhcrm-transaction-'));
  const appRoot = path.join(root, 'app');
  const releases = path.join(appRoot, 'releases');
  const incoming = path.join(appRoot, 'incoming');
  const oldRelease = path.join(releases, 'initial');
  const candidate = path.join(releases, releaseId);
  const stageLog = path.join(root, 'stages.log');
  const marker = path.join(root, 'injected-failure-once');
  const interruptMarker = path.join(root, 'interrupted-once');
  const mockBin = path.join(root, 'bin');
  const control = path.join(root, 'control');
  const scriptCopy = path.join(root, 'deploy-release.sh');

  mkdirSync(path.join(oldRelease, 'server', 'src'), { recursive: true });
  mkdirSync(path.join(oldRelease, 'client', 'dist'), { recursive: true });
  mkdirSync(incoming, { recursive: true });
  mkdirSync(path.join(appRoot, 'shared'), { recursive: true });
  mkdirSync(mockBin);
  writeFileSync(path.join(appRoot, 'shared', 'backend.env'), 'test-only\n');
  writeFileSync(path.join(oldRelease, 'server', 'src', 'server.js'), 'old');
  writeFileSync(path.join(oldRelease, 'client', 'dist', 'index.html'), 'old');
  symlinkSync(oldRelease, path.join(appRoot, 'current'), 'dir');
  writeFileSync(path.join(incoming, `${releaseId}.tar.gz`), makeArchive(archiveEntries));
  writeFileSync(
    path.join(incoming, `${releaseId}.safe-release-archive.mjs`),
    readFileSync(path.resolve('deploy/safe-release-archive.mjs')),
  );

  const npm = path.join(mockBin, 'npm');
  const sudo = path.join(mockBin, 'sudo');
  const curl = path.join(mockBin, 'curl');
  const mv = path.join(mockBin, 'mv');
  const stat = path.join(mockBin, 'stat');
  executable(npm, `#!/bin/sh
case "$PWD" in
  */server)
    printf 'server-npm:%s\\n' "$*" >> "$LHCRM_STAGE_LOG"
    mkdir -p node_modules/prisma/build node_modules/@prisma/client node_modules/@prisma/adapter-pg
    cat > node_modules/prisma/build/index.js <<'NODE'
require('node:fs').appendFileSync(process.env.LHCRM_STAGE_LOG, 'generate\\n');
if (process.env.LHCRM_FAIL_GENERATE === 'true') process.exit(1);
NODE
    printf '{"type":"module","exports":"./index.js"}\\n' > node_modules/@prisma/client/package.json
    printf 'export class PrismaClient {}\\n' > node_modules/@prisma/client/index.js
    printf '{"type":"module","exports":"./index.js"}\\n' > node_modules/@prisma/adapter-pg/package.json
    printf 'export class PrismaPg {}\\n' > node_modules/@prisma/adapter-pg/index.js
    [ "\${LHCRM_FAIL_NPM:-false}" != true ]
    ;;
  */client)
    printf 'client-npm:%s\\n' "$*" >> "$LHCRM_STAGE_LOG"
    if [ "$1" = run ] && [ "$2" = build ]; then
      mkdir -p dist/assets
      printf 'export {};\\n' > dist/assets/main.js
      printf '<html><script type="module" src="/assets/main.js"></script></html>\\n' > dist/index.html
      [ "\${LHCRM_FAIL_BUILD:-false}" != true ]
    else
      [ "\${LHCRM_FAIL_NPM:-false}" != true ]
    fi
    ;;
  *) exit 2 ;;
esac
`);
  executable(sudo, '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n');
  executable(curl, `#!/bin/sh
active=$(readlink -f "$LHCRM_CURRENT")
if [ "\${LHCRM_INTERRUPT_DEPLOY:-false}" = true ] && [ ! -e "$LHCRM_INTERRUPT_MARKER" ]; then
  : > "$LHCRM_INTERRUPT_MARKER"
  kill -TERM "$PPID"
fi
if [ "$active" = "$LHCRM_CANDIDATE" ] && [ "\${LHCRM_FAIL_HEALTH_NEW:-false}" = true ]; then
  exit 22
fi
exit 0
`);
  executable(mv, `#!/bin/bash
target="\${3:-}"
if [[ "$target" == "$LHCRM_CURRENT" && "\${LHCRM_FAIL_CURRENT_SWITCH:-false}" == true ]]; then
  exit 1
fi
if [[ "$target" == "$LHCRM_PREVIOUS" && "\${LHCRM_FAIL_PREVIOUS_SWITCH:-false}" == true &&
      ! -e "$LHCRM_FAILURE_MARKER" ]]; then
  : > "$LHCRM_FAILURE_MARKER"
  exit 1
fi
printf 'switch:%s\\n' "$target" >> "$LHCRM_STAGE_LOG"
exec /bin/mv "$@"
`);
  executable(stat, '#!/bin/sh\nprintf "1000\\n"\n');
  executable(control, `#!/bin/bash
action="\${1:-}"
printf '%s\\n' "$action" >> "$LHCRM_CONTROL_LOG"
active=$(readlink -f "$LHCRM_CURRENT")
case "$action" in
  activate-release)
    target="$LHCRM_RELEASES/$2"
    temporary="$LHCRM_CURRENT.next"
    ln -s "$target" "$temporary"
    "$MOCK_MV" -Tf "$temporary" "$LHCRM_CURRENT"
    ;;
  seal-release)
    [[ "\${LHCRM_FAIL_SEAL:-false}" != true ]]
    ;;
  migrate-status)
    [[ "\${LHCRM_PENDING:-false}" != true && "\${LHCRM_FAIL_STATUS:-false}" != true ]]
    ;;
  migrate-preflight)
    [[ "\${LHCRM_FAIL_PREFLIGHT:-false}" != true ]]
    ;;
  migrate-deploy)
    [[ "\${LHCRM_FAIL_MIGRATION:-false}" != true ]]
    ;;
  restart-backend)
    [[ "$active" != "$LHCRM_CANDIDATE" || "\${LHCRM_FAIL_RESTART_NEW:-false}" != true ]]
    ;;
  backend-active)
    [[ "$active" != "$LHCRM_CANDIDATE" || "\${LHCRM_FAIL_ACTIVE_NEW:-false}" != true ]]
    ;;
  reload-nginx)
    true
    ;;
  validate-config)
    true
    ;;
  startup-check)
    [[ "$active" != "$LHCRM_CANDIDATE" || "\${LHCRM_FAIL_STARTUP_NEW:-false}" != true ]]
    ;;
  *) exit 2 ;;
esac
`);

  const original = readFileSync(path.resolve('deploy/deploy-release.sh'), 'utf8').replace(/\r\n/g, '\n');
  const isolated = original
    .replace('readonly APP_ROOT=/opt/lakshmi-hyundai', `readonly APP_ROOT='${appRoot}'`)
    .replace('readonly HEALTH_URL=http://127.0.0.1:4000/api/v1/health', 'readonly HEALTH_URL=http://127.0.0.1/test')
    .replace('readonly FRONTEND_HOST=lakshmi-hyundai-crm.tech', 'readonly FRONTEND_HOST=local.test')
    .replace('readonly CONTROL=/usr/local/sbin/lakshmi-hyundai-deploy-control', `readonly CONTROL='${control}'`)
    .replaceAll('/usr/bin/node', process.execPath)
    .replace('/usr/bin/stat -c %u -- "$release"', '"$MOCK_STAT" -c %u -- "$release"')
    .replaceAll('v24.22.2', process.version)
    .replace('npm ci --omit=dev --no-audit --no-fund', '"$MOCK_NPM" ci --omit=dev --no-audit --no-fund')
    .replace('npm ci --no-audit --no-fund', '"$MOCK_NPM" ci --no-audit --no-fund')
    .replace('npm run build', '"$MOCK_NPM" run build')
    .replaceAll('sudo -n "$CONTROL"', '"$MOCK_SUDO" -n "$CONTROL"')
    .replaceAll('curl --silent', '"$MOCK_CURL" --silent')
    .replace('mv -Tf "$temporary" "$link"', '"$MOCK_MV" -Tf "$temporary" "$link"');
  writeFileSync(scriptCopy, isolated);

  try {
    callback({
      appRoot,
      releases,
      run(applyMigrations = false, overrides = {}) {
        writeFileSync(stageLog, '');
        const result = spawnSync('bash', [scriptCopy, releaseId, commitSha, String(applyMigrations)], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            MOCK_NPM: npm,
            MOCK_SUDO: sudo,
            MOCK_CURL: curl,
            MOCK_MV: mv,
            MOCK_STAT: stat,
            LHCRM_CURRENT: path.join(appRoot, 'current'),
            LHCRM_RELEASES: releases,
            LHCRM_PREVIOUS: path.join(releases, 'previous'),
            LHCRM_CANDIDATE: candidate,
            LHCRM_STAGE_LOG: stageLog,
            LHCRM_CONTROL_LOG: stageLog,
            LHCRM_FAILURE_MARKER: marker,
            LHCRM_INTERRUPT_MARKER: interruptMarker,
            ...overrides,
          },
          timeout: 30_000,
        });
        return {
          ...result,
          active: realpathSync(path.join(appRoot, 'current')),
          oldRelease,
          candidate,
          stageLog: readFileSync(stageLog, 'utf8'),
          controlLog: readFileSync(stageLog, 'utf8'),
          stateExists: existsSync(path.join(releases, '.deployment-state')),
          stageExists: existsSync(path.join(releases, `.staging-${releaseId}`)),
          releaseExists: existsSync(candidate),
          artifactExists: existsSync(path.join(incoming, `${releaseId}.tar.gz`)),
          incoming,
          releases,
          appRoot,
        };
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('prepares dependencies, checks migration status, then activates the release', { skip: isWindows }, () => {
  withFixture(({ run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.active, result.candidate);
    assert.equal(result.stateExists, true);
    assert.match(result.stageLog, /server-npm:ci --omit=dev --no-audit --no-fund/);
    assert.match(result.stageLog, /client-npm:ci --no-audit --no-fund/);
    const order = [
      result.stageLog.indexOf('npm'),
      result.stageLog.indexOf('generate'),
      result.controlLog.indexOf('seal-release'),
      result.controlLog.indexOf('migrate-status'),
      result.stageLog.indexOf(`switch:${path.join(result.appRoot, 'current')}`),
      result.controlLog.indexOf('restart-backend'),
    ];
    assert.ok(order.every((index) => index >= 0), `missing deployment stage: ${order.join(',')}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.doesNotMatch(result.controlLog, /migrate-deploy/);
    assert.equal(existsSync(path.join(result.oldRelease, 'client', 'dist', 'index.html')), true);

    rmSync(path.join(result.releases, '.deployment-state'));
    const duplicate = run();
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(duplicate.active, result.candidate);
    assert.match(duplicate.stdout, /already active and healthy/);
    assert.doesNotMatch(duplicate.stageLog, /server-npm|client-npm/);
    assert.equal(duplicate.stateExists, false);
  });
});

for (const [label, variables] of [
  ['dependency installation', { LHCRM_FAIL_NPM: 'true' }],
  ['Prisma generation', { LHCRM_FAIL_GENERATE: 'true' }],
  ['release sealing', { LHCRM_FAIL_SEAL: 'true' }],
  ['migration status check', { LHCRM_FAIL_STATUS: 'true' }],
  ['migration preflight', { LHCRM_PENDING: 'true', LHCRM_FAIL_PREFLIGHT: 'true' }],
  ['migration execution', { LHCRM_PENDING: 'true', LHCRM_FAIL_MIGRATION: 'true' }],
]) {
  test(`recovers before activation when ${label} fails`, { skip: isWindows }, () => {
    withFixture(({ run }) => {
      const needsMigrations = Boolean(variables.LHCRM_PENDING);
      const result = run(needsMigrations, variables);
      assert.notEqual(result.status, 0);
      assert.equal(result.active, result.oldRelease);
      assert.equal(result.stateExists, false);
      assert.equal(result.artifactExists, true);
    });
  });
}

test('does not apply pending migrations during an ordinary deployment', { skip: isWindows }, () => {
  withFixture(({ run }) => {
    const result = run(false, { LHCRM_PENDING: 'true' });
    assert.notEqual(result.status, 0);
    assert.equal(result.active, result.oldRelease);
    assert.doesNotMatch(result.controlLog, /migrate-deploy/);
  });
});

test('preserves an unfinished transaction owned by an earlier deployment attempt', { skip: isWindows }, () => {
  withFixture(({ run, releases }) => {
    const state = path.join(releases, '.deployment-state');
    const previousTransaction = `b${'a'.repeat(39)}\tprevious-target\tcandidate-target\tactivating\n`;
    writeFileSync(state, previousTransaction);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(state, 'utf8'), previousTransaction);
    assert.equal(result.active, result.oldRelease);
  });
});

test('reports migration/application mismatch when activation fails after migration success', { skip: isWindows }, () => {
  withFixture(({ run }) => {
    const result = run(true, { LHCRM_PENDING: 'true', LHCRM_FAIL_PREVIOUS_SWITCH: 'true' });
    assert.notEqual(result.status, 0);
    assert.equal(result.active, result.oldRelease);
    assert.match(result.stderr, /migrations may have succeeded.*does not restore the previous database schema/);
    assert.equal(result.stateExists, false);
    assert.equal(result.releaseExists, true);
  });
});

test('recovers when the first active-symlink replacement fails', { skip: isWindows }, () => {
  withFixture(({ run }) => {
    const result = run(false, { LHCRM_FAIL_CURRENT_SWITCH: 'true' });
    assert.notEqual(result.status, 0);
    assert.equal(result.active, result.oldRelease);
    assert.equal(result.stateExists, false);
  });
});

test('recovers on SIGTERM during post-activation health checking', { skip: isWindows }, () => {
  withFixture(({ run }) => {
    const result = run(false, { LHCRM_INTERRUPT_DEPLOY: 'true' });
    assert.notEqual(result.status, 0);
    assert.equal(result.active, result.oldRelease);
    assert.equal(result.stateExists, false);
    assert.match(result.controlLog, /restart-backend/);
  });
});

for (const [label, variables] of [
  ['restart', { LHCRM_FAIL_RESTART_NEW: 'true' }],
  ['service-active check', { LHCRM_FAIL_ACTIVE_NEW: 'true' }],
  ['health check', { LHCRM_FAIL_HEALTH_NEW: 'true' }],
  ['startup log check', { LHCRM_FAIL_STARTUP_NEW: 'true' }],
]) {
  test(`restores the previous release when the ${label} fails`, { skip: isWindows }, () => {
    withFixture(({ run }) => {
      const result = run(false, variables);
      assert.notEqual(result.status, 0);
      assert.equal(result.active, result.oldRelease);
      assert.equal(result.stateExists, false);
      assert.match(result.controlLog, /restart-backend/, `${result.stdout}\n${result.stderr}`);
    });
  });
}

test('rejects a malformed archive before writing outside staging', { skip: isWindows }, () => {
  const malicious = [...requiredFiles, ['../../shared/backend.env', 'overwrite']];
  withFixture(({ run, appRoot }) => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.equal(result.active, result.oldRelease);
    assert.equal(readFileSync(path.join(appRoot, 'shared', 'backend.env'), 'utf8'), 'test-only\n');
    assert.equal(result.stageExists, false);
  }, malicious);
});
