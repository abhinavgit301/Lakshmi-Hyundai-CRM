import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const IDENTITY_FILE = '/etc/lakshmi-hyundai/database-identity.json';

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

export function loadExpectedDatabaseIdentity(filePath = IDENTITY_FILE) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 || stat.size > 4096) {
    throw new Error('Database identity configuration must be a small, root-owned, non-writable regular file.');
  }
  return validateExpectedDatabaseIdentity(readFileSync(filePath, 'utf8'));
}

export function assertDatabaseIdentity(connection, actual, expected) {
  const actualHost = connection.hostname.toLowerCase();
  const actualDatabase = decodeURIComponent(connection.pathname.slice(1));
  const actualPort = Number(connection.port || 5432);
  const actualUsername = decodeURIComponent(connection.username);
  const actualServerAddress = typeof actual.server_address === 'string'
    ? actual.server_address.split('/')[0].toLowerCase()
    : '';
  if (actualDatabase !== expected.database ||
      actualHost !== expected.host.toLowerCase() ||
      actualPort !== expected.port ||
      actualUsername !== expected.username ||
      actual.database !== expected.database ||
      actual.username !== expected.username ||
      typeof actual.server_address !== 'string' ||
      !actual.server_address.trim() ||
      actualServerAddress !== expected.host.toLowerCase() ||
      Number(actual.server_port) !== expected.port) {
    throw new Error('Refusing migrations: configured database endpoint identity does not match the live connection.');
  }
}
