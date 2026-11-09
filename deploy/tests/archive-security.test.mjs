import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  ['server/prisma/schema.prisma', ''],
  ['server/prisma/migrations/migration_lock.toml', ''],
  ['server/prisma/migrations/20261106000000_test/migration.sql', 'SELECT 1;\n'],
  ['client/index.html', '<html></html>\n'],
  ['client/package.json', '{}\n'],
  ['client/package-lock.json', '{}\n'],
  ['client/vite.config.js', 'export default {};\n'],
  ['client/src/main.jsx', ''],
];

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

    await extractReleaseArchive(archive, stage);

    assert.equal(readFileSync(path.join(stage, 'client/index.html'), 'utf8'), '<html></html>\n');
    assert.equal(readFileSync(path.join(stage, 'server/prisma/migrations/20261106000000_test/migration.sql'), 'utf8'), 'SELECT 1;\n');
  });
});

for (const [label, malicious] of [
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
