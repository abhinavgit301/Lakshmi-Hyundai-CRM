import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../phase7-dba-evidence.sql', import.meta.url), 'utf8');
const script = readFileSync(new URL('../collect-phase7-dba-evidence.sh', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../../docs/PHASE7-PRODUCTION-DBA-EVIDENCE.md', import.meta.url), 'utf8');

test('DBA evidence SQL is read-only and starts a read-only transaction', () => {
  assert.match(sql, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(sql, /COMMIT;/);
  assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|VACUUM|REFRESH)\b/im);
});

test('catalog inventory handles supported relation kinds without index ACL inspection', () => {
  assert.match(sql, /c\.relkind IN \('r', 'p', 'v', 'm'\)/);
  assert.match(sql, /c\.relkind = 'S'/);
  assert.match(sql, /acldefault\('r', c\.relowner\)/);
  assert.match(sql, /acldefault\('S', c\.relowner\)/);
  assert.match(sql, /acldefault\('f', p\.proowner\)/);
  assert.match(sql, /acldefault\('T', t\.typowner\)/);
  assert.doesNotMatch(sql, /acldefault\('i'/);
  assert.doesNotMatch(sql, /relkind\s*=\s*'i'/);
});

test('PUBLIC and explicit versus default ACL evidence is retained', () => {
  assert.match(sql, /CASE WHEN acl\.grantee = 0 THEN 'PUBLIC'/);
  assert.match(sql, /relacl IS NULL AS uses_default_acl/);
  assert.match(sql, /proacl IS NULL AS uses_default_acl/);
  assert.match(sql, /typacl IS NULL AS uses_default_acl/);
  assert.match(sql, /nspacl IS NULL AS uses_default_acl/);
});

test('pg_stat_activity evidence excludes query text and exposes session identity only', () => {
  assert.match(sql, /FROM pg_stat_activity/);
  assert.match(sql, /application_name/);
  assert.match(sql, /usename/);
  assert.doesNotMatch(sql, /\bpg_stat_activity\.[\w]*query\b|SELECT\s+.*\bquery\b/i);
});

test('migration history is discovered by schema and table name', () => {
  assert.match(sql, /c\.relname = '_prisma_migrations'/);
  assert.match(sql, /FROM %I\.%I/);
  assert.match(sql, /\\gexec/);
});

test('collector defaults to print-only and executes psql explicitly', () => {
  assert.match(script, /execute=false/);
  assert.match(script, /--execute-read-only/);
  assert.match(script, /Print-only mode/);
  assert.match(script, /--no-password/);
  assert.match(script, /--no-psqlrc/);
  assert.match(script, /--dbname="\$database"/);
  assert.match(script, /--file="\$sql_file"/);
  assert.doesNotMatch(script, /postgres(?:ql)?:\/\/|PGPASSWORD=/);
});

test('collector shell built-ins are not referenced as executables', () => {
  assert.doesNotMatch(script, /\/usr\/bin\/(umask|read)\b/);
  assert.match(script, /umask 077/);
});

test('collector output directory and evidence files are private', () => {
  assert.match(script, /mkdir -m 0700/);
  assert.match(script, /chmod 0600/);
  assert.match(script, /\(8#\$mode & 0077\)/);
});

test('identity-file and systemd documentation is explicit', () => {
  assert.match(docs, /lakshmi-deploy/);
  assert.match(docs, /Root-owned mode `0600` is not readable/);
  assert.match(docs, /root:lakshmi-deploy/);
  assert.match(docs, /0640/);
  assert.match(docs, /--no-owner/);
  assert.match(docs, /--no-privileges/);
  assert.match(docs, /246252251/);
  assert.match(docs, /7e741d04d3e44a0c1ac096d9345671c15fb79fd64f68e964697198000d07b234/);
});
