import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertRealRelease, consumeNonce, verifiedClaims } from '../migration-authorization.mjs';

const releaseId = 'a'.repeat(40);
const commitSha = 'a'.repeat(40);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

function signedAuthorization(overrides = {}) {
  const claims = {
    version: 1,
    repository: 'abhinavgit301/Lakshmi-Hyundai-CRM',
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
    environment: 'production',
    migrationApproval: true,
    releaseId,
    commitSha,
    runId: '123',
    runAttempt: '1',
    issuedAt: 1000,
    expiresAt: 1300,
    nonce: Buffer.alloc(32, 7).toString('base64url'),
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return JSON.stringify({ payload, signature });
}

test('accepts a signed, release-specific, unexpired manual authorization', () => {
  assert.equal(verifiedClaims(signedAuthorization(), releaseId, commitSha, publicKeyPem, 1100).releaseId, releaseId);
});

test('rejects authorization bound to another release', () => {
  assert.throws(() => verifiedClaims(
    signedAuthorization(),
    'b'.repeat(40),
    commitSha,
    publicKeyPem,
    1100,
  ), /claims are invalid/);
});

test('rejects invalid release identifiers', () => {
  assert.throws(() => verifiedClaims(signedAuthorization(), '../outside', commitSha, publicKeyPem, 1100), /identifier/);
});

test('rejects release symlink redirection', { skip: process.platform === 'win32' }, (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lhcrm-release-'));
  try {
    const releases = path.join(root, 'releases');
    const outside = path.join(root, 'outside');
    mkdirSync(releases);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'RELEASE_COMMIT'), `${commitSha}\n`);
    try {
      symlinkSync(outside, path.join(releases, releaseId), 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('Creating symlinks requires elevated Windows permissions.');
        return;
      }
      throw error;
    }
    assert.throws(() => assertRealRelease(releaseId, commitSha, releases), /real directory inside releases/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects expired authorization and any event other than manual dispatch', () => {
  assert.throws(() => verifiedClaims(signedAuthorization(), releaseId, commitSha, publicKeyPem, 1300), /expired/);
  assert.throws(() => verifiedClaims(
    signedAuthorization({ event: 'push' }),
    releaseId,
    commitSha,
    publicKeyPem,
    1100,
  ), /claims are invalid/);
});

test('rejects authorization lifetimes longer than 30 minutes', () => {
  assert.throws(() => verifiedClaims(
    signedAuthorization({ expiresAt: 2801 }),
    releaseId,
    commitSha,
    publicKeyPem,
    1100,
  ), /claims are invalid/);
});

test('rejects a modified authorization signature', () => {
  const authorization = JSON.parse(signedAuthorization());
  const firstCharacter = authorization.signature[0] === 'A' ? 'B' : 'A';
  authorization.signature = `${firstCharacter}${authorization.signature.slice(1)}`;
  assert.throws(() => verifiedClaims(
    JSON.stringify(authorization),
    releaseId,
    commitSha,
    publicKeyPem,
    1100,
  ), /signature is invalid/);
});

test('consumes an authorization nonce once and rejects replay', { skip: process.getuid === undefined }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lhcrm-auth-'));
  try {
    const state = path.join(root, 'used-nonces');
    const owner = process.getuid();
    const nonce = Buffer.alloc(32, 11).toString('base64url');
    consumeNonce(nonce, state, owner);
    assert.throws(() => consumeNonce(nonce, state, owner), /already been used/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
