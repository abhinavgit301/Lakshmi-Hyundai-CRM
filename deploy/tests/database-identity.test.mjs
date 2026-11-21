import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertDatabaseIdentity, loadExpectedDatabaseIdentity, validateExpectedDatabaseIdentity, validateSystemdCredentialStat } from '../database-identity.mjs';

const expected = {
  database: 'lakshmi_hyundai_crm',
  host: 'db.internal.example',
  port: 5432,
  username: 'lhcrm_app',
};
const connection = new URL('postgresql://lhcrm_app:irrelevant@db.internal.example:5432/lakshmi_hyundai_crm');
const actual = {
  database: 'lakshmi_hyundai_crm',
  session_user: 'lhcrm_app',
  current_user: 'lhcrm_app',
  rolsuper: false,
  rolinherit: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolcanlogin: true,
  membership_count: 0,
  server_address: 'db.internal.example',
  server_port: 5432,
};

test('validates the pinned production database identity', () => {
  assert.deepEqual(validateExpectedDatabaseIdentity(JSON.stringify(expected)), expected);
  assert.doesNotThrow(() => assertDatabaseIdentity(connection, actual, expected));
});

test('requires a fixed systemd credential directory for the matching migration mode', () => {
  const release = 'a'.repeat(40);
  for (const [directory, mode] of [
    [undefined, 'status'],
    ['/etc/lakshmi-hyundai', 'status'],
    [`/run/credentials/lakshmi-hyundai-migrate@${release}.service`, 'status'],
    [`/run/credentials/lakshmi-hyundai-migrate-status@${release}.service/..`, 'status'],
    [`/run/credentials/lakshmi-hyundai-migrate-status@${release}.service`, 'unknown'],
    [`/run/credentials/lakshmi-hyundai-migrate-status@${'A'.repeat(40)}.service`, 'status'],
  ]) {
    assert.throws(() => loadExpectedDatabaseIdentity(directory, mode), /Missing or invalid systemd/);
  }
  for (const [suffix, mode] of [['-status', 'status'], ['-preflight', 'preflight'], ['', 'apply']]) {
    const directory = `/run/credentials/lakshmi-hyundai-migrate${suffix}@${release}.service`;
    assert.throws(() => loadExpectedDatabaseIdentity(directory, mode), /ENOENT/);
  }
});

test('requires a protected regular systemd credential owned by root or the service', () => {
  const stat = { isFile: () => true, uid: 0, mode: 0o440, size: 4096 };
  assert.doesNotThrow(() => validateSystemdCredentialStat(stat, 1000));
  assert.doesNotThrow(() => validateSystemdCredentialStat({ ...stat, uid: 1000, mode: 0o400 }, 1000));
  for (const invalid of [
    { isFile: () => false },
    { uid: 1001 },
    { mode: 0o600 },
    { mode: 0o420 },
    { mode: 0o402 },
    { size: 4097 },
  ]) {
    assert.throws(() => validateSystemdCredentialStat({ ...stat, ...invalid }, 1000), /protected regular file/);
  }
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
    session_user: 'lakshmi_db_admin',
    current_user: 'lakshmi_db_admin',
    rolsuper: false,
    rolinherit: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolcanlogin: true,
    membership_count: 0,
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
    { ...actual, session_user: 'other_user' },
    expected,
  ), /identity does not match/);
  assert.throws(() => assertDatabaseIdentity(
    connection,
    { ...actual, current_user: 'other_user' },
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
  assert.throws(() => validateExpectedDatabaseIdentity({ ...expected, username: '' }), /missing or invalid/);
  assert.throws(() => validateExpectedDatabaseIdentity({ ...expected, username: 'lhcrm_app\nother' }), /missing or invalid/);
});

test('rejects missing or ambiguous live identity fields', () => {
  for (const field of [
    'session_user',
    'current_user',
    'database',
    'rolsuper',
    'rolinherit',
    'rolbypassrls',
    'rolcreaterole',
    'rolcreatedb',
    'rolreplication',
    'rolcanlogin',
    'membership_count',
  ]) {
    const incomplete = { ...actual };
    delete incomplete[field];
    assert.throws(
      () => assertDatabaseIdentity(connection, incomplete, expected),
      /missing or ambiguous/,
    );
  }

  assert.throws(
    () => assertDatabaseIdentity(connection, { ...actual, membership_count: -1 }, expected),
    /missing or ambiguous/,
  );
  assert.throws(
    () => assertDatabaseIdentity(connection, { ...actual, membership_count: 1.5 }, expected),
    /missing or ambiguous/,
  );
  assert.throws(
    () => assertDatabaseIdentity(connection, { ...actual, membership_count: '0' }, expected),
    /missing or ambiguous/,
  );
});

test('rejects prohibited role attributes and unexpected memberships', () => {
  for (const field of [
    'rolsuper',
    'rolbypassrls',
    'rolcreaterole',
    'rolcreatedb',
    'rolreplication',
  ]) {
    assert.throws(
      () => assertDatabaseIdentity(connection, { ...actual, [field]: true }, expected),
      /identity does not match/,
    );
  }

  assert.throws(
    () => assertDatabaseIdentity(connection, { ...actual, rolinherit: true }, expected),
    /identity does not match/,
  );
  assert.throws(
    () => assertDatabaseIdentity(connection, { ...actual, rolcanlogin: false }, expected),
    /identity does not match/,
  );
  assert.throws(
    () => assertDatabaseIdentity(connection, { ...actual, membership_count: 1 }, expected),
    /identity does not match/,
  );
});

test('precheck requires one live row and verifies Design A pg.Client identity fields', () => {
  const source = readFileSync(
    new URL('../check-prisma-migrations.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /process\.env\.MIGRATION_DATABASE_URL\?\.trim\(\)/);
  assert.match(source, /MIGRATION_DATABASE_URL is not available/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
  assert.match(source, /session_user::text AS session_user/);
  assert.match(source, /current_user::text AS current_user/);
  assert.match(source, /r\.rolsuper/);
  assert.match(source, /r\.rolinherit/);
  assert.match(source, /r\.rolbypassrls/);
  assert.match(source, /r\.rolcreaterole/);
  assert.match(source, /r\.rolcreatedb/);
  assert.match(source, /r\.rolreplication/);
  assert.match(source, /r\.rolcanlogin/);
  assert.match(source, /SELECT count\(\*\)::int/);
  assert.match(source, /WHERE member_role\.rolname = session_user/);
  assert.match(source, /if \(identity\.rows\.length !== 1\)/);
  assert.match(source, /live migration identity is missing or ambiguous/);
});
