import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { extractReleaseArchive } from '../safe-release-archive.mjs';

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarEntry(name, body = '', type = '0', link = '') {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(type === '5' ? 0o750 : 0o640, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(data.length, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

const requiredFiles = [
  ['RELEASE_COMMIT', `${'a'.repeat(40)}\n`],
  ['server/src/server.js', 'console.log("server");\n'],
  ['server/package.json', '{}\n'],
  ['server/package-lock.json', '{}\n'],
  ['server/prisma.config.ts', 'export default {};\n'],
  ['server/deploy/check-prisma-migrations.mjs', ''],
  ['server/deploy/database-identity.mjs', ''],
  ['server/deploy/migration-policy.mjs', ''],
  ['server/prisma/schema.prisma', ''],
  ['server/prisma/migrations/migration_lock.toml', ''],
  ['server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/migration.sql', 'SELECT 1;\n'],
  ['server/prisma/migrations/20261121000000_nullable_unlinked_assignment_history/migration.sql',
    'ALTER TABLE "cre_assignment_history" ALTER COLUMN "vehicleId" DROP NOT NULL;\n'],
  ['client/index.html', '<html></html>\n'],
  ['client/package.json', '{}\n'],
  ['client/package-lock.json', '{}\n'],
  ['client/vite.config.js', 'export default {};\n'],
  ['client/src/main.jsx', ''],
];

test('CI and archive allow only the approved schema-first candidate migration', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const deferredBlock = workflow.match(/excluded_candidate_migrations=\(\s*([\s\S]*?)\s*\)/);
  assert.ok(deferredBlock, 'release workflow must define the excluded candidate migration list');
  assert.deepEqual(
    [...deferredBlock[1].matchAll(/"([^"]+)"/g)].map(([, migration]) => migration),
    [
      '20261119000000_cre_vehicle_assignment_projection',
      '20261120000000_assignment_read_indexes',
      '20261120000001_allocation_vehicle_ccm_fk',
      '20261120000002_remove_unused_physical_vehicle_last_service_date',
    ],
  );
  const allowedBlock = workflow.match(/allowed_migrations=\(\s*([\s\S]*?)\s*\)/);
  assert.ok(allowedBlock, 'release workflow must define its exact migration allow-list');
  const workflowAllowed = [...allowedBlock[1].matchAll(/"([^"]+)"/g)].map(([, migration]) => migration);
  const extractor = readFileSync(new URL('../safe-release-archive.mjs', import.meta.url), 'utf8');
  const extractorBlock = extractor.match(/const allowedMigrationDirectories = \[([\s\S]*?)\];/);
  assert.ok(extractorBlock, 'archive extractor must define its exact migration allow-list');
  const extractorAllowed = [...extractorBlock[1].matchAll(/'([^']+)'/g)].map(([, migration]) => migration);
  assert.deepEqual(workflowAllowed, extractorAllowed);
  const excluded = [...deferredBlock[1].matchAll(/"([^"]+)"/g)].map(([, migration]) => migration);
  assert.equal(workflowAllowed.includes('20261121000000_nullable_unlinked_assignment_history'), true);
  assert.equal(workflowAllowed.some((migration) => excluded.includes(migration)), false);
  assert.deepEqual(
    readdirSync(new URL('../../server/prisma/migrations', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    [...workflowAllowed, ...excluded].sort(),
  );
});

function makeArchive(entries) {
  const blocks = entries.map(([name, body, type, link]) => tarEntry(name, body, type, link));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function withScratch(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lhcrm-archive-'));
  try {
    await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('extracts the complete expected release tree using fixed safe modes', async () => {
  await withScratch(async (root) => {
    const archive = path.join(root, 'release.tar.gz');
    const stage = path.join(root, 'stage');
    mkdirSync(stage);
    writeFileSync(archive, makeArchive(requiredFiles));

    const extracted = await extractReleaseArchive(archive, stage);

    assert.equal(readFileSync(path.join(stage, 'client/index.html'), 'utf8'), '<html></html>\n');
    assert.equal(
      readFileSync(path.join(stage, 'server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/migration.sql'), 'utf8'),
      'SELECT 1;\n',
    );
    assert.equal(
      readFileSync(path.join(stage, 'server/prisma/migrations/20261121000000_nullable_unlinked_assignment_history/migration.sql'), 'utf8'),
      'ALTER TABLE "cre_assignment_history" ALTER COLUMN "vehicleId" DROP NOT NULL;\n',
    );
    assert.deepEqual(
      [...extracted.names.keys()].filter((name) => name.startsWith('server/prisma/migrations/')).sort(),
      [
        'server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/migration.sql',
        'server/prisma/migrations/20261121000000_nullable_unlinked_assignment_history/migration.sql',
        'server/prisma/migrations/migration_lock.toml',
      ].sort(),
    );
  });
});

test('accepts a rollback.sql inside a migration directory', async () => {
  await withScratch(async (root) => {
    const archive = path.join(root, 'release.tar.gz');
    const stage = path.join(root, 'stage');
    mkdirSync(stage);
    const rollback = 'server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/rollback.sql';
    writeFileSync(archive, makeArchive([...requiredFiles, [rollback, 'SELECT 2;\n']]));

    await extractReleaseArchive(archive, stage);

    assert.equal(readFileSync(path.join(stage, rollback), 'utf8'), 'SELECT 2;\n');
  });
});

for (const [label, malicious] of [
  ...[
    '20261119000000_cre_vehicle_assignment_projection',
    '20261120000000_assignment_read_indexes',
    '20261120000001_allocation_vehicle_ccm_fk',
    '20261120000002_remove_unused_physical_vehicle_last_service_date',
  ].flatMap((migration) => [
    [`deferred migration directory ${migration}`, [[`server/prisma/migrations/${migration}`, '', '5']]],
    [`deferred migration file ${migration}`, [[`server/prisma/migrations/${migration}/migration.sql`, 'SELECT 1;\n']]],
  ]),
  ['unexpected migration directory', [['server/prisma/migrations/20261122000000_unreviewed/migration.sql', 'SELECT 1;\n']]],
  ['unexpected file in permitted candidate migration', [['server/prisma/migrations/20261121000000_nullable_unlinked_assignment_history/rollback.sql', 'SELECT 1;\n']]],
  ['rollback.sql outside a migration directory', [['server/prisma/rollback.sql', 'x']]],
  ['rollback.sql nested below a migration directory', [['server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/sub/rollback.sql', 'x']]],
  ['rollback.sql directly in the migrations directory', [['server/prisma/migrations/rollback.sql', 'x']]],
  ['rollback.sql as a symlink', [['server/prisma/migrations/20261027000000_free_service_warranty_followup_categories/rollback.sql', '', '2', '../../../../../shared/backend.env']]],
  ['parent traversal', [['../shared/backend.env', 'overwrite']]],
  ['malformed NUL-terminated path', [['server/src/valid.js\0../../shared/backend.env', 'overwrite']]],
  ['absolute path', [['/opt/lakshmi-hyundai/shared/backend.env', 'overwrite']]],
  ['symlink entry', [['server/src/evil.js', '', '2', '../../../../shared/backend.env']]],
  ['hard link entry', [['server/prisma/schema.prisma', '', '1', '/etc/passwd']]],
  ['device entry', [['server/prisma/schema.prisma', '', '3']]],
  ['extended metadata entry', [['PaxHeaders/release', 'path=../../shared/backend.env\n', 'x']]],
  ['wrong directory entry type', [['server/src', 'not-a-directory']]],
  ['unexpected top-level path', [['backups/restore.sql', 'overwrite']]],
  ['legacy renamed application directory', [['backend/package.json', '{}']]],
  ['environment file', [['server/src/.env.production', 'secret']]],
  ['nested backup', [['server/src/backups/restore.sql', 'backup']]],
  ['nested test output', [['client/src/tests/report.html', 'report']]],
]) {
  test(`rejects ${label} before extracting any member`, async () => {
    await withScratch(async (root) => {
      const archive = path.join(root, 'malicious.tar.gz');
      const stage = path.join(root, 'stage');
      const outside = path.join(root, 'shared');
      mkdirSync(stage);
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'backend.env'), 'sentinel');
      writeFileSync(archive, makeArchive([...requiredFiles, ...malicious]));

      await assert.rejects(extractReleaseArchive(archive, stage));

      assert.equal(readFileSync(path.join(outside, 'backend.env'), 'utf8'), 'sentinel');
      assert.deepEqual(await (await import('node:fs/promises')).readdir(stage), []);
    });
  });
}

test('rejects duplicate archive members before writing any file', async () => {
  await withScratch(async (root) => {
    const archive = path.join(root, 'duplicate.tar.gz');
    const stage = path.join(root, 'stage');
    mkdirSync(stage);
    writeFileSync(archive, makeArchive([...requiredFiles, ['client/index.html', 'replacement']]));

    await assert.rejects(extractReleaseArchive(archive, stage), /Duplicate/);

    assert.deepEqual(await (await import('node:fs/promises')).readdir(stage), []);
  });
});
