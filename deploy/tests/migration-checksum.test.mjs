import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalMigrationChecksum, migrationChecksumMatches } from '../database-identity.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const lfSql = 'CREATE TABLE a (id INT);\nSELECT 1;\n';
const crlfSql = lfSql.replace(/\n/g, '\r\n');

test('accepts the exact checksum of the committed LF bytes', () => {
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha(lfSql)), true);
});

test('accepts a CRLF-recorded checksum for LF-committed bytes', () => {
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha(crlfSql)), true);
});

test('accepts an LF-recorded checksum for CRLF-committed bytes', () => {
  assert.equal(migrationChecksumMatches(Buffer.from(crlfSql), sha(lfSql)), true);
});

test('rejects changed SQL, including whitespace-only changes', () => {
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha(lfSql.replace('SELECT 1', 'SELECT 2'))), false);
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha(`${lfSql} `)), false);
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha(lfSql.replace('SELECT', 'SELECT '))), false);
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha(lfSql.replace(/\n/g, '\r'))), false);
});

test("rejects another migration's checksum", () => {
  assert.equal(migrationChecksumMatches(Buffer.from(lfSql), sha('ALTER TABLE b ADD COLUMN c INT;\n')), false);
});

test('rejects missing or malformed recorded checksums', () => {
  for (const value of [undefined, null, '', 42, 'not-a-checksum']) {
    assert.equal(migrationChecksumMatches(Buffer.from(lfSql), value), false);
  }
});

test('LF and CRLF forms of identical SQL share one canonical checksum', () => {
  assert.equal(canonicalMigrationChecksum(Buffer.from(lfSql)), canonicalMigrationChecksum(Buffer.from(crlfSql)));
  assert.equal(canonicalMigrationChecksum(Buffer.from(lfSql)), sha(lfSql));
});

test('genuine SQL changes produce a different canonical checksum', () => {
  assert.notEqual(canonicalMigrationChecksum(Buffer.from(lfSql)), canonicalMigrationChecksum(Buffer.from(lfSql.replace('SELECT 1', 'SELECT 2'))));
  assert.notEqual(canonicalMigrationChecksum(Buffer.from(lfSql)), canonicalMigrationChecksum(Buffer.from(lfSql.replace(/\n/g, '\r'))));
});

test('canonicalisation does not mutate its input', () => {
  const input = Buffer.from(crlfSql);
  canonicalMigrationChecksum(input);
  assert.equal(input.toString(), crlfSql);
});

test('real 20261027 migration: LF and CRLF checkouts both canonicalise to the Git blob hash', () => {
  const file = new URL('../../server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/migration.sql', import.meta.url);
  const raw = readFileSync(file);
  const lf = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  const crlf = Buffer.from(lf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
  const blob = '6790321dad2ae8af22d4a4f915eaf782f7244ff53f45a3099f3341768f06dd66';
  assert.equal(lf.length, 3303);
  assert.equal(crlf.length, 3359);
  assert.equal(canonicalMigrationChecksum(lf), blob);
  assert.equal(canonicalMigrationChecksum(crlf), blob);
  assert.equal(sha(crlf), '75ae061b164e60e08b883366b357fd5a22182d8735aa99bcba7684c12bc326ae');
});

test('production case: LF blob hash 6790… matches recorded CRLF hash 75ae…', () => {
  const recorded = '75ae061b164e60e08b883366b357fd5a22182d8735aa99bcba7684c12bc326ae';
  const file = new URL('../../server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/migration.sql', import.meta.url);
  assert.equal(migrationChecksumMatches(readFileSync(file), recorded), true);
});

test('validator keeps unfinished and rolled-back record handling and uses the helper', () => {
  const source = readFileSync(new URL('../check-prisma-migrations.mjs', import.meta.url), 'utf8');
  assert.match(source, /row\.started_at && !row\.finished_at && !row\.rolled_back_at/);
  assert.match(source, /if \(!row\.finished_at \|\| row\.rolled_back_at\) continue;/);
  assert.match(source, /!migrationChecksumMatches\(committed\.bytes, row\.checksum\)/);
  assert.doesNotMatch(source, /committed\.checksum/);
});
