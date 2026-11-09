import { createHash } from 'node:crypto';
import {
  createReadStream,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { finished } from 'node:stream/promises';

const blockSize = 512;
const maxCompressedBytes = 256 * 1024 * 1024;
const maxExpandedBytes = 1024 * 1024 * 1024;
const maxEntries = 100_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(message);
}

function readString(field) {
  const end = field.indexOf(0);
  if (end < 0) return decoder.decode(field);
  if (field.subarray(end + 1).some((byte) => byte !== 0)) {
    fail('Tar path field contains data after its null terminator.');
  }
  return decoder.decode(field.subarray(0, end));
}

function readOctal(field, label) {
  if ((field[0] & 0x80) !== 0) fail(`Base-256 tar ${label} values are not accepted.`);
  const value = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) fail(`Malformed tar ${label}.`);
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail(`Tar ${label} is outside the supported range.`);
  return number;
}

class TarReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async read(length) {
    while (this.buffer.length < length) {
      const { value, done } = await this.iterator.next();
      if (done) fail('Truncated tar archive.');
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : value;
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  async drainAndRequireZeros() {
    if (this.buffer.some((byte) => byte !== 0)) fail('Non-zero data follows the tar end marker.');
    for await (const chunk of { [Symbol.asyncIterator]: () => this.iterator }) {
      if (chunk.some((byte) => byte !== 0)) fail('Non-zero data follows the tar end marker.');
    }
  }
}

function canonicalMember(header) {
  const name = readString(header.subarray(0, 100));
  const prefix = readString(header.subarray(345, 500));
  const raw = prefix ? `${prefix}/${name}` : name;
  if (raw === './' || raw === '.') return '';
  if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
    fail('Absolute, empty, or malformed tar paths are not accepted.');
  }
  const normalized = raw.startsWith('./') ? raw.slice(2) : raw;
  const withoutTrailingSlash = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = withoutTrailingSlash.split('/');
  if (
    !withoutTrailingSlash ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes(':')) ||
    /[\x00-\x1f\x7f]/.test(withoutTrailingSlash)
  ) {
    fail('Malformed or traversing tar path.');
  }
  return withoutTrailingSlash;
}

function containsForbiddenPath(name) {
  return name.split('/').some((part) => {
    const lower = part.toLowerCase();
    return lower.startsWith('.env') ||
      ['.git', 'backup', 'backups', 'coverage', 'node_modules', 'secrets', 'tests'].includes(lower) ||
      /(^|[._-])backup([._-]|$)/.test(lower) ||
      /\.(bak|old|orig|save|swp|tmp)$/.test(lower);
  });
}

function allowedMember(name, kind) {
  if (name && containsForbiddenPath(name)) return false;
  if (name === '') return kind === 'directory';
  if (name === 'server' || name === 'client') return kind === 'directory';
  if (name === 'RELEASE_COMMIT') return kind === 'file';
  if (name === 'server/src' || name === 'client/src' || name === 'client/public') return kind === 'directory';
  if (name.startsWith('client/src/') || name.startsWith('client/public/')) {
    return kind === 'file' || kind === 'directory';
  }
  if (name === 'client/index.html' || name === 'client/package.json' ||
      name === 'client/package-lock.json' || name === 'client/vite.config.js') return kind === 'file';
  if (name.startsWith('server/src/')) return kind === 'file' || kind === 'directory';
  if (name === 'server/package.json' || name === 'server/package-lock.json' ||
      name === 'server/prisma.config.ts' ||
      name === 'server/deploy/check-prisma-migrations.mjs' ||
      name === 'server/deploy/database-identity.mjs' ||
      name === 'server/prisma/schema.prisma' ||
      name === 'server/prisma/migrations/migration_lock.toml') return kind === 'file';
  if (name === 'server/deploy' || name === 'server/prisma' ||
      name === 'server/prisma/migrations') return kind === 'directory';
  if (/^server\/prisma\/migrations\/[^/]+$/.test(name)) return kind === 'directory';
  if (/^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name)) return kind === 'file';
  return false;
}

function validateHeader(header, names) {
  const expectedChecksum = readOctal(header.subarray(148, 156), 'checksum');
  let actualChecksum = 0;
  for (let index = 0; index < blockSize; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actualChecksum !== expectedChecksum) fail('Tar header checksum mismatch.');

  const magic = header.subarray(257, 263).toString('ascii');
  if (magic !== 'ustar\0') fail('Only POSIX ustar archives are accepted.');
  const type = header[156];
  const kind = type === 0 || type === 48 ? 'file' : type === 53 ? 'directory' : null;
  if (!kind) fail('Tar links, devices, extensions, and special files are not accepted.');
  const name = canonicalMember(header);
  const size = readOctal(header.subarray(124, 136), 'size');
  if ((kind === 'directory' && size !== 0) || (kind === 'file' && name.endsWith('/'))) {
    fail('Invalid tar entry type or size.');
  }
  if (!allowedMember(name, kind)) fail(`Unexpected release archive member: ${name || '.'}.`);
  if (names.has(name)) fail(`Duplicate release archive member: ${name || '.'}.`);
  for (const [existing, existingKind] of names) {
    if (existing && name.startsWith(`${existing}/`) && existingKind !== 'directory') {
      fail(`Tar path descends from a non-directory member: ${existing}.`);
    }
    if (name && existing.startsWith(`${name}/`) && kind !== 'directory') {
      fail(`Tar member would replace a required parent directory: ${name}.`);
    }
  }
  names.set(name, kind);
  return { name, kind, size };
}

function ensureDirectory(stage, relative) {
  let current = stage;
  if (lstatSync(current).isSymbolicLink()) fail('Staging directory cannot be a symbolic link.');
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Extraction parent is not a real directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o750 });
    }
  }
}

function safeFilePath(stage, member) {
  const resolved = path.resolve(stage, ...member.split('/'));
  if (!resolved.startsWith(`${path.resolve(stage)}${path.sep}`)) fail('Tar member escapes staging directory.');
  return resolved;
}

async function parseArchive(archive, stage) {
  const input = createReadStream(archive);
  const digest = createHash('sha256');
  let compressedBytes = 0;
  input.on('data', (chunk) => {
    compressedBytes += chunk.length;
    if (compressedBytes > maxCompressedBytes) input.destroy(new Error('Release archive exceeds size limit.'));
    digest.update(chunk);
  });
  const gunzip = createGunzip();
  input.pipe(gunzip);
  const reader = new TarReader(gunzip);
  const names = new Map();
  let expandedBytes = 0;
  let entryCount = 0;
  let zeroBlocks = 0;

  try {
    while (true) {
      const header = await reader.read(blockSize);
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) {
          await reader.drainAndRequireZeros();
          break;
        }
        continue;
      }
      if (zeroBlocks) fail('Tar archive has a single end marker before another entry.');
      entryCount += 1;
      if (entryCount > maxEntries) fail('Release archive has too many members.');
      const member = validateHeader(header, names);
      expandedBytes += member.size;
      if (expandedBytes > maxExpandedBytes) fail('Expanded release archive exceeds size limit.');
      if (member.kind === 'directory' && stage) {
        const directory = member.name ? safeFilePath(stage, member.name) : stage;
        ensureDirectory(stage, member.name);
        if (directory !== stage) {
          const stat = lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Tar directory is not a real directory.');
        }
      }

      let output = null;
      if (stage && member.kind === 'file') {
        const parent = path.posix.dirname(member.name);
        ensureDirectory(stage, parent === '.' ? '' : parent);
        const filePath = safeFilePath(stage, member.name);
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          (constants.O_NOFOLLOW || 0);
        const fd = openSync(filePath, flags, 0o640);
        output = { fd, remaining: member.size };
      }
      let remaining = member.size;
      while (remaining > 0) {
        const chunk = await reader.read(Math.min(remaining, 64 * 1024));
        if (output) {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(output.fd, chunk, offset);
        }
        remaining -= chunk.length;
      }
      if (output) closeSync(output.fd);
      const padding = (blockSize - (member.size % blockSize)) % blockSize;
      if (padding) await reader.read(padding);
    }
  } finally {
    input.destroy();
    gunzip.destroy();
    await finished(input).catch(() => {});
  }
  return { digest: digest.digest('hex'), names };
}

export async function extractReleaseArchive(archive, stage) {
  const initialStat = lstatSync(archive);
  if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.size > maxCompressedBytes) {
    fail('Release archive must be a regular file within the configured size limit.');
  }
  const validation = await parseArchive(archive, null);
  const currentStat = lstatSync(archive);
  if (!currentStat.isFile() || currentStat.ino !== initialStat.ino ||
      currentStat.size !== initialStat.size || currentStat.mtimeMs !== initialStat.mtimeMs) {
    fail('Release archive changed during validation.');
  }
  const stageStat = lstatSync(stage);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail('Staging path must be a new real directory.');
  if (readdirSync(stage).length !== 0) fail('Staging directory must be empty before extraction.');
  const extracted = await parseArchive(archive, stage);
  if (extracted.digest !== validation.digest) fail('Release archive changed between validation and extraction.');
  for (const required of [
    'RELEASE_COMMIT',
    'server/src/server.js',
    'server/package.json',
    'server/package-lock.json',
    'server/prisma.config.ts',
    'server/deploy/check-prisma-migrations.mjs',
    'server/deploy/database-identity.mjs',
    'server/prisma/schema.prisma',
    'server/prisma/migrations/migration_lock.toml',
    'client/index.html',
    'client/package.json',
    'client/package-lock.json',
    'client/vite.config.js',
    'client/src/main.jsx',
  ]) {
    if (!extracted.names.has(required)) fail(`Required release archive member is missing: ${required}.`);
  }
  if (![...extracted.names.keys()].some((name) =>
    /^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name))) {
    fail('Release archive contains no Prisma migration SQL files.');
  }
  return extracted;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, archive, stage] = process.argv.slice(2);
  if (command !== 'extract' || !archive || !stage) {
    console.error('Usage: safe-release-archive.mjs extract <archive> <empty-stage-directory>');
    process.exitCode = 2;
  } else {
    try {
      await extractReleaseArchive(archive, stage);
    } catch (error) {
      console.error(`Release archive rejected: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
