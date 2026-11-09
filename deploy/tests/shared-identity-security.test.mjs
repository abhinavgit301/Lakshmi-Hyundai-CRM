import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const workflow = read('../../.github/workflows/deploy.yml');
const helper = read('../lakshmi-hyundai-deploy-control');
const backendHardening = read('../systemd/lakshmi-hyundai-backend-hardening.conf');
const migrationUnits = [
  read('../systemd/lakshmi-hyundai-migrate@.service'),
  read('../systemd/lakshmi-hyundai-migrate-status@.service'),
  read('../systemd/lakshmi-hyundai-migrate-preflight@.service'),
];
const docs = read('../../docs/GITHUB-ACTIONS-DEPLOYMENT.md');
const alternateAccount = ['lhcrm', 'deploy'].join('-');

test('deployment uses only the existing lakshmi-deploy account', () => {
  assert.match(workflow, /VPS_USER" == lakshmi-deploy/);
  assert.match(workflow, /test "\$\(id -un\)" = lakshmi-deploy/);
  assert.match(helper, /SUDO_USER:-\}" == lakshmi-deploy/);
  for (const unit of migrationUnits) {
    assert.match(unit, /^User=lakshmi-deploy$/m);
    assert.match(unit, /^Group=lakshmi-deploy$/m);
    assert.match(unit, /\/opt\/lakshmi-hyundai\/releases\/%i\/server/);
  }
  assert.doesNotMatch(`${workflow}\n${helper}\n${migrationUnits.join('\n')}\n${docs}`, new RegExp(alternateAccount));
});

test('backend unit and Nginx root consistently use the top-level current symlink', () => {
  const backendUnit = read('../systemd/lakshmi-hyundai-backend-current.conf');
  const nginxRoot = read('../nginx/lakshmi-hyundai-crm-root.conf');
  assert.match(backendUnit, /^WorkingDirectory=\/opt\/lakshmi-hyundai\/current\/server$/m);
  assert.match(backendUnit, /^ExecStart=\/usr\/bin\/node src\/server\.js$/m);
  assert.match(backendUnit, /^EnvironmentFile=\/opt\/lakshmi-hyundai\/shared\/backend\.env$/m);
  assert.match(nginxRoot, /^root \/opt\/lakshmi-hyundai\/current\/client\/dist;$/m);
  assert.match(workflow, /RELEASE_ID="\$DEPLOY_SHA"/);
  assert.match(workflow, /"\$package\/server"/);
  assert.match(workflow, /"\$package\/client"/);
});

test('runtime preflight verifies the exact Node version before any artifact transfer', () => {
  const preflight = workflow.indexOf('name: Verify VPS runtime before transfer');
  const transfer = workflow.indexOf('name: Transfer package and deploy release');
  assert.ok(preflight >= 0 && transfer > preflight);
  assert.match(workflow.slice(preflight, transfer), /\/usr\/bin\/node --version\)" = v24\.22\.2/);
  assert.match(workflow.slice(preflight, transfer), /sudo -n .*deploy-control preflight/);
});

test('backend and migration services cannot write deployment or credential paths', () => {
  for (const unit of [backendHardening, ...migrationUnits]) {
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /^ProtectHome=true$/m);
    assert.match(unit, /^PrivateTmp=true$/m);
    assert.match(unit, /^ReadOnlyPaths=\/opt\/lakshmi-hyundai\/releases/m);
    assert.match(unit, /^ReadOnlyPaths=\/opt\/lakshmi-hyundai\/shared\/backend\.env$/m);
    assert.doesNotMatch(unit, /^ReadWritePaths=/m);
  }
  for (const unit of migrationUnits) {
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^CapabilityBoundingSet=$/m);
    assert.match(unit, /^RestrictSUIDSGID=true$/m);
  }
  assert.match(backendHardening, /^NoNewPrivileges=true$/m);
  assert.match(backendHardening, /^CapabilityBoundingSet=$/m);
  assert.match(backendHardening, /^RestrictSUIDSGID=true$/m);
});

test('preflight enforces protected SSH home, environment, helper, verifier, and system configuration', () => {
  assert.match(helper, /getent passwd lakshmi-deploy/);
  assert.match(helper, /-p InaccessiblePaths --value/);
  assert.match(helper, /"\$home_is_protected" == true/);
  assert.match(helper, /"\$backend_env_uid" == 0/);
  assert.match(helper, /"\$helper_uid" == 0/);
  assert.match(helper, /"\$verifier_uid" == 0/);
  assert.match(helper, /"\$public_key_uid" == 0/);
  assert.match(helper, /"\$database_identity_uid" == 0/);
  assert.match(helper, /"\$\(\(8#\$backend_env_mode & 0077\)\)" -eq 0/);
  assert.match(helper, /"\$\(\(8#\$helper_mode & 07022\)\)" -eq 0/);
  assert.match(helper, /"\$\(\(8#\$verifier_mode & 07022\)\)" -eq 0/);
});

test('release sealing makes deployment artifacts root-owned and non-writable', () => {
  assert.match(helper, /chown -R root:lakshmi-deploy -- "\$release"/);
  assert.match(helper, /chmod -R a-w,a\+rX -- "\$release"/);
  assert.match(backendHardening, /^ReadOnlyPaths=\/opt\/lakshmi-hyundai\/releases$/m);
  assert.match(docs, /Preserve the account UID\/GID, home, SSH ownership\/configuration, and all existing authorized keys/);
  assert.match(docs, /private key remains a GitHub Environment secret, never on the VPS/);
});
