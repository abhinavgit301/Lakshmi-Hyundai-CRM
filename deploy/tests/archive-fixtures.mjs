import { gzipSync } from 'node:zlib';

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

export const requiredFiles = [
  ['RELEASE_COMMIT', `${'a'.repeat(40)}\n`],
  ['server/package.json', '{"name":"test-server"}\n'],
  ['server/package-lock.json', '{}\n'],
  ['server/prisma.config.ts', 'export default {};\n'],
  ['server/deploy/check-prisma-migrations.mjs', 'export {};\n'],
  ['server/deploy/database-identity.mjs', 'export {};\n'],
  ['server/prisma/schema.prisma', 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n'],
  ['server/prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n'],
  ['server/prisma/migrations/20261106000000_test/migration.sql', 'SELECT 1;\n'],
  ['server/src/server.js', 'console.log("test server");\n'],
  ['client/index.html', '<html><body><script type="module" src="/src/main.jsx"></script></body></html>\n'],
  ['client/package.json', '{"name":"test-client"}\n'],
  ['client/package-lock.json', '{}\n'],
  ['client/vite.config.js', 'export default {};\n'],
  ['client/src/main.jsx', ''],
];

export function makeArchive(entries) {
  const blocks = entries.map(([name, body, type, link]) => tarEntry(name, body, type, link));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
