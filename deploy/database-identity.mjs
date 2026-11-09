import { lstatSync, readFileSync } from 'node:fs';

const IDENTITY_FILE = '/etc/lakshmi-hyundai/database-identity.json';

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
  if (actualDatabase !== expected.database ||
      actualHost !== expected.host.toLowerCase() ||
      actualPort !== expected.port ||
      actualUsername !== expected.username ||
      actual.database !== expected.database ||
      actual.username !== expected.username ||
      typeof actual.server_address !== 'string' ||
      !actual.server_address.trim() ||
      actual.server_address.toLowerCase() !== expected.host.toLowerCase() ||
      Number(actual.server_port) !== expected.port) {
    throw new Error('Refusing migrations: configured database endpoint identity does not match the live connection.');
  }
}
