import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const toLf = (bytes) => Buffer.from(Buffer.from(bytes).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

// Canonical checksum: SHA-256 of the migration with CRLF sequences converted to LF.
// Only CRLF is rewritten; every other byte (including a lone CR) is preserved.
export function canonicalMigrationChecksum(migrationBytes) {
  return sha256(toLf(migrationBytes));
}

// Prisma records the checksum of the file bytes at resolve time, so identical SQL can be
// recorded with LF or CRLF endings. Only CRLF/LF differences are tolerated.
export function migrationChecksumMatches(migrationBytes, recordedChecksum) {
  if (typeof recordedChecksum !== 'string') return false;
  const bytes = Buffer.from(migrationBytes);
  const lf = toLf(bytes);
  const crlf = Buffer.from(lf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
  return [bytes, lf, crlf].some((candidate) => sha256(candidate) === recordedChecksum);
}

export function validateExpectedDatabaseIdentity(value) {
  const identity = typeof value === 'string' ? JSON.parse(value) : value;
  if (!identity || typeof identity !== 'object' ||
      identity.database !== 'lakshmi_hyundai_crm' ||
      typeof identity.host !== 'string' || !/^[A-Za-z0-9._:[\]-]+$/.test(identity.host) ||
      !Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65535 ||
      typeof identity.username !== 'string' || !identity.username.trim() ||
      /[\r\n]/.test(identity.username)) {
    throw new Error('Configured production database identity is missing or invalid.');
  }
  return identity;
}

export function validateSystemdCredentialStat(stat, serviceUid) {
  if (!stat.isFile() || (stat.uid !== 0 && stat.uid !== serviceUid) ||
      (stat.mode & 0o222) !== 0 || stat.size > 4096) {
    throw new Error('Systemd database identity credential must be a small, protected regular file.');
  }
}

export function loadExpectedDatabaseIdentity(credentialDirectory, mode) {
  const suffixes = new Map([['status', '-status'], ['preflight', '-preflight'], ['apply', '']]);
  const suffix = suffixes.get(mode);
  if (suffix === undefined || typeof credentialDirectory !== 'string' ||
      !new RegExp(`^/run/credentials/lakshmi-hyundai-migrate${suffix}@[0-9a-f]{40}\\.service$`).test(credentialDirectory)) {
    throw new Error('Missing or invalid systemd database identity credential directory.');
  }
  const file = path.posix.join(credentialDirectory, 'database-identity.json');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    validateSystemdCredentialStat(fstatSync(fd), process.getuid?.());
    return validateExpectedDatabaseIdentity(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

export function assertDatabaseIdentity(connection, actual, expected) {
  const actualHost = connection.hostname.toLowerCase();
  const actualDatabase = decodeURIComponent(connection.pathname.slice(1));
  const actualPort = Number(connection.port || 5432);
  const actualUsername = decodeURIComponent(connection.username);
  const actualServerAddress = typeof actual.server_address === 'string'
    ? actual.server_address.split('/')[0].toLowerCase()
    : '';
  if (typeof actual.session_user !== 'string' || !actual.session_user ||
      typeof actual.current_user !== 'string' || !actual.current_user ||
      typeof actual.database !== 'string' || !actual.database ||
      typeof actual.rolsuper !== 'boolean' ||
      typeof actual.rolinherit !== 'boolean' ||
      typeof actual.rolbypassrls !== 'boolean' ||
      typeof actual.rolcreaterole !== 'boolean' ||
      typeof actual.rolcreatedb !== 'boolean' ||
      typeof actual.rolreplication !== 'boolean' ||
      typeof actual.rolcanlogin !== 'boolean' ||
      !Number.isInteger(actual.membership_count) ||
      actual.membership_count < 0) {
    throw new Error('Refusing migrations: live migration identity information is missing or ambiguous.');
  }
  if (actualDatabase !== expected.database ||
      actualHost !== expected.host.toLowerCase() ||
      actualPort !== expected.port ||
      actualUsername !== expected.username ||
      actual.database !== expected.database ||
      actual.session_user !== expected.username ||
      actual.current_user !== expected.username ||
      actual.rolsuper !== false ||
      actual.rolinherit !== false ||
      actual.rolbypassrls !== false ||
      actual.rolcreaterole !== false ||
      actual.rolcreatedb !== false ||
      actual.rolreplication !== false ||
      actual.rolcanlogin !== true ||
      actual.membership_count !== 0 ||
      typeof actual.server_address !== 'string' ||
      !actual.server_address.trim() ||
      actualServerAddress !== expected.host.toLowerCase() ||
      Number(actual.server_port) !== expected.port) {
    throw new Error('Refusing migrations: configured database endpoint identity does not match the live connection.');
  }
}
