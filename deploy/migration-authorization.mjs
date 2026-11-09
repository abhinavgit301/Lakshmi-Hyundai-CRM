import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import {
  constants,
  chownSync,
  closeSync,
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = '/opt/lakshmi-hyundai';
const RELEASES = path.join(APP_ROOT, 'releases');
const INCOMING = path.join(APP_ROOT, 'incoming');
const RUNTIME = '/run/lhcrm-migration-auth';
const STATE = '/var/lib/lakshmi-hyundai-deploy-auth/used-nonces';
const PUBLIC_KEY = '/etc/lakshmi-hyundai/migration-authorization.pub';
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_AUTHORIZATION_LIFETIME_SECONDS = 1800;
const releasePattern = /^[0-9a-f]{40}$/;

function assertReleaseId(releaseId) {
  if (!releasePattern.test(releaseId ?? '')) throw new Error('Invalid migration release identifier.');
}

function readRegularFile(filePath, maxBytes = MAX_TOKEN_BYTES) {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Authorization input is not a bounded regular file.');
    return readFileSync(fd, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
}

function readTrustedPublicKey() {
  const stat = lstatSync(PUBLIC_KEY);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 || stat.size > 4096) {
    throw new Error('Migration authorization public key is not safely installed.');
  }
  return readFileSync(PUBLIC_KEY, 'utf8');
}

export function verifiedClaims(serialized, releaseId, commitSha, publicKeyText, now = Math.floor(Date.now() / 1000)) {
  assertReleaseId(releaseId);
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    throw new Error('Migration authorization is malformed.');
  }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(envelope.payload) || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)) {
    throw new Error('Migration authorization envelope is invalid.');
  }
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (signature.length !== 64 ||
      !verify(null, Buffer.from(envelope.payload), createPublicKey(publicKeyText), signature)) {
    throw new Error('Migration authorization signature is invalid.');
  }
  const claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  if (
    claims.version !== 1 ||
    claims.repository !== 'abhinavgit301/Lakshmi-Hyundai-CRM' ||
    claims.event !== 'workflow_dispatch' ||
    claims.ref !== 'refs/heads/main' ||
    claims.environment !== 'production' ||
    claims.migrationApproval !== true ||
    claims.releaseId !== releaseId ||
    claims.commitSha !== commitSha ||
    !/^[0-9]+$/.test(claims.runId ?? '') ||
    !/^[0-9]+$/.test(claims.runAttempt ?? '') ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt > now + 30 ||
    claims.expiresAt <= now ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MAX_AUTHORIZATION_LIFETIME_SECONDS ||
    !/^[A-Za-z0-9_-]{43}$/.test(claims.nonce ?? '')
  ) {
    throw new Error('Migration authorization claims are invalid, expired, or scoped to another release.');
  }
  return claims;
}

export function assertRealRelease(releaseId, commitSha, releasesRoot = RELEASES) {
  assertReleaseId(releaseId);
  const release = path.join(releasesRoot, releaseId);
  const stat = lstatSync(release);
  const realReleaseRoot = realpathSync(releasesRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      path.dirname(realpathSync(release)) !== realReleaseRoot) {
    throw new Error('Migration release must resolve to a direct real directory inside releases.');
  }
  const marker = readRegularFile(path.join(release, 'RELEASE_COMMIT'), 128).trim();
  if (marker !== commitSha) throw new Error('Authorization commit does not match the release marker.');
}

function ensureRuntimeDirectory() {
  const groupLine = execFileSync('/usr/bin/getent', ['group', 'lakshmi-deploy'], { encoding: 'utf8' }).trim();
  const groupId = Number(groupLine.split(':')[2]);
  if (!Number.isSafeInteger(groupId)) throw new Error('The required lakshmi-deploy group is unavailable.');
  try {
    mkdirSync(RUNTIME, { recursive: false, mode: 0o750 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(RUNTIME);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('Migration authorization runtime directory is not safely owned.');
  }
  chownSync(RUNTIME, 0, groupId);
  chmodSync(RUNTIME, 0o750);
  return groupId;
}

export function consumeNonce(nonce, stateDirectory = STATE, expectedOwner = 0) {
  const stateParent = path.dirname(stateDirectory);
  mkdirSync(stateParent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(stateParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      parentStat.uid !== expectedOwner || (parentStat.mode & 0o077) !== 0) {
    throw new Error('Migration replay state parent is not safely owned.');
  }
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const stateStat = lstatSync(stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || stateStat.uid !== expectedOwner ||
      (stateStat.mode & 0o077) !== 0) {
    throw new Error('Migration replay state is not safely owned.');
  }
  const nonceHash = createHash('sha256').update(nonce).digest('hex');
  const marker = path.join(stateDirectory, nonceHash);
  let fd;
  try {
    fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${nonceHash}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Migration authorization has already been used.');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function safelyWrite(filePath, contents, mode, groupId) {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  chownSync(filePath, 0, groupId);
}

export function authorizeForSystemd(releaseId) {
  assertReleaseId(releaseId);
  const release = path.join(RELEASES, releaseId);
  const releaseStat = lstatSync(release);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || releaseStat.uid !== 0 ||
      (releaseStat.mode & 0o022) !== 0 ||
      path.dirname(realpathSync(release)) !== realpathSync(RELEASES)) {
    throw new Error('Migration release must resolve to a direct real directory inside releases.');
  }
  const commitSha = readRegularFile(path.join(release, 'RELEASE_COMMIT'), 128).trim();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Release commit marker is invalid.');
  assertRealRelease(releaseId, commitSha);
  const source = path.join(INCOMING, `${releaseId}.migration-auth.json`);
  const serialized = readRegularFile(source);
  const claims = verifiedClaims(serialized, releaseId, commitSha, readTrustedPublicKey());
  const groupId = ensureRuntimeDirectory();
  const tokenPath = path.join(RUNTIME, `${releaseId}.json`);
  const permitPath = path.join(RUNTIME, `${releaseId}.permit`);
  safelyWrite(tokenPath, serialized, 0o440, groupId);
  safelyWrite(permitPath, `${claims.nonce}\n${randomBytes(32).toString('hex')}\n`, 0o600, 0);
  return claims;
}

export function consumeForMigration(releaseId) {
  assertReleaseId(releaseId);
  const release = path.join(RELEASES, releaseId);
  const commitSha = readRegularFile(path.join(release, 'RELEASE_COMMIT'), 128).trim();
  assertRealRelease(releaseId, commitSha);
  const tokenPath = path.join(RUNTIME, `${releaseId}.json`);
  const permitPath = path.join(RUNTIME, `${releaseId}.permit`);
  const permit = readRegularFile(permitPath, 256).trim().split('\n');
  if (permit.length !== 2 || !/^[a-f0-9]{64}$/.test(permit[1])) {
    throw new Error('Migration execution permit is invalid.');
  }
  const claims = verifiedClaims(
    readRegularFile(tokenPath),
    releaseId,
    commitSha,
    readTrustedPublicKey(),
  );
  const suppliedNonce = Buffer.from(permit[0]);
  const signedNonce = Buffer.from(claims.nonce);
  if (suppliedNonce.length !== signedNonce.length || !timingSafeEqual(suppliedNonce, signedNonce)) {
    throw new Error('Migration execution permit does not match the signed authorization.');
  }
  consumeNonce(claims.nonce);
  unlinkSync(permitPath);
  return claims;
}

export function cleanupAuthorization(releaseId) {
  assertReleaseId(releaseId);
  for (const suffix of ['.json', '.permit']) {
    try {
      unlinkSync(path.join(RUNTIME, `${releaseId}${suffix}`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, releaseId] = process.argv.slice(2);
  try {
    if (operation === 'authorize') authorizeForSystemd(releaseId);
    else if (operation === 'consume') consumeForMigration(releaseId);
    else if (operation === 'cleanup') cleanupAuthorization(releaseId);
    else throw new Error('Usage: migration-authorization.mjs authorize|consume|cleanup <release-id>');
  } catch (error) {
    console.error(`Migration authorization rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
