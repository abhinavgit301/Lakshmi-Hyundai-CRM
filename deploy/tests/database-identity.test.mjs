import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDatabaseIdentity, validateExpectedDatabaseIdentity } from '../database-identity.mjs';

const expected = {
  database: 'lakshmi_hyundai_crm',
  host: 'db.internal.example',
  port: 5432,
  username: 'lhcrm_app',
};
const connection = new URL('postgresql://lhcrm_app:irrelevant@db.internal.example:5432/lakshmi_hyundai_crm');
const actual = {
  database: 'lakshmi_hyundai_crm',
  username: 'lhcrm_app',
  server_address: 'db.internal.example',
  server_port: 5432,
};

test('validates the pinned production database identity', () => {
  assert.deepEqual(validateExpectedDatabaseIdentity(JSON.stringify(expected)), expected);
  assert.doesNotThrow(() => assertDatabaseIdentity(connection, actual, expected));
});

test('accepts PostgreSQL IPv4 inet addresses with a /32 host prefix', () => {
  const ipExpected = {
    database: 'lakshmi_hyundai_crm',
    host: '172.18.0.2',
    port: 5432,
    username: 'lakshmi_db_admin',
  };
  const ipConnection = new URL('postgresql://lakshmi_db_admin:irrelevant@172.18.0.2:5432/lakshmi_hyundai_crm');
  const ipActual = {
    database: 'lakshmi_hyundai_crm',
    username: 'lakshmi_db_admin',
    server_address: '172.18.0.2/32',
    server_port: 5432,
  };

  assert.doesNotThrow(() => assertDatabaseIdentity(ipConnection, ipActual, ipExpected));
});
test('rejects a different endpoint, database, user, or port', () => {
  assert.throws(() => assertDatabaseIdentity(
    new URL('postgresql://lhcrm_app@other.example:5432/lakshmi_hyundai_crm'),
    actual,
    expected,
  ), /identity does not match/);
  assert.throws(() => assertDatabaseIdentity(
    connection,
    { ...actual, username: 'other_user' },
    expected,
  ), /identity does not match/);
  assert.throws(() => assertDatabaseIdentity(
    connection,
    { ...actual, server_port: 5433 },
    expected,
  ), /identity does not match/);
});

test('rejects a mismatched live server address even when the connection URL matches', () => {
  assert.throws(() => assertDatabaseIdentity(
    connection,
    { ...actual, server_address: 'other.internal.example' },
    expected,
  ), /identity does not match/);
});

test('rejects a missing, null, or empty live server address', () => {
  for (const serverAddress of [undefined, null, '']) {
    const identity = { ...actual, server_address: serverAddress };
    if (serverAddress === undefined) delete identity.server_address;
    assert.throws(() => assertDatabaseIdentity(connection, identity, expected), /identity does not match/);
  }
});

test('rejects incomplete or malformed pinned identity', () => {
  assert.throws(() => validateExpectedDatabaseIdentity({ ...expected, host: 'bad host' }), /missing or invalid/);
  assert.throws(() => validateExpectedDatabaseIdentity({ ...expected, port: 70000 }), /missing or invalid/);
});
