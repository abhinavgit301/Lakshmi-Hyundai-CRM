import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const expectedDatabase = 'lakshmi_hyundai_crm';
const mode = process.argv[2];
if (mode !== 'status' && mode !== 'apply') {
  throw new Error('Usage: check-prisma-migrations.mjs status|apply');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not available in the systemd environment.');
const connection = new URL(connectionString);
const database = decodeURIComponent(connection.pathname.slice(1));
const schema = connection.searchParams.get('schema') || 'public';
if (database !== expectedDatabase) {
  throw new Error(`Refusing migrations: connected database is not ${expectedDatabase}.`);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
  throw new Error('Refusing migrations: database schema name is invalid.');
}

const client = new pg.Client({ connectionString });
const quotedSchema = `"${schema}"`;
try {
  await client.connect();
  const identity = await client.query(
    `SELECT current_database() AS database, current_user AS username,
      inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
      current_setting('server_version') AS server_version,
      to_regclass($1)::text AS migration_table`,
    [`${quotedSchema}."_prisma_migrations"`],
  );
  const databaseIdentity = identity.rows[0];
  if (databaseIdentity.database !== expectedDatabase || !databaseIdentity.migration_table) {
    throw new Error('Refusing migrations: expected database or Prisma migration history table is missing.');
  }
  console.log(`Verified migration database: ${JSON.stringify(databaseIdentity)}`);

  const [history, migrations] = await Promise.all([
    client.query(
      `SELECT migration_name, checksum, started_at, finished_at, rolled_back_at
       FROM ${quotedSchema}."_prisma_migrations"`,
    ),
    Promise.resolve(
      readdirSync(path.resolve('prisma/migrations'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const migrationPath = path.resolve('prisma/migrations', entry.name, 'migration.sql');
          return {
            name: entry.name,
            checksum: createHash('sha256').update(readFileSync(migrationPath)).digest('hex'),
          };
        }),
    ),
  ]);
  const committedByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const applied = new Set();
  for (const row of history.rows) {
    if (row.started_at && !row.finished_at && !row.rolled_back_at) {
      throw new Error(`Migration ${row.migration_name} has an unfinished database record.`);
    }
    if (!row.finished_at || row.rolled_back_at) continue;
    const committed = committedByName.get(row.migration_name);
    if (!committed) throw new Error(`Applied migration ${row.migration_name} is absent from this release.`);
    if (committed.checksum !== row.checksum) {
      throw new Error(`Applied migration ${row.migration_name} differs from its committed checksum.`);
    }
    applied.add(row.migration_name);
  }

  const pending = migrations.filter(({ name }) => !applied.has(name)).map(({ name }) => name);
  console.log(`Pending committed migrations: ${pending.length ? pending.join(', ') : 'none'}`);
  if (!pending.length) process.exitCode = 0;
  else if (mode === 'status') {
    throw new Error('Pending migrations exist; deployment is blocked unless explicitly approved.');
  } else {
    const activeMigrationRoot = '/opt/lakshmi-hyundai/releases/current/backend/prisma/migrations';
    let activeNames;
    try {
      activeNames = new Set(
        readdirSync(activeMigrationRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      );
    } catch {
      throw new Error('Cannot verify the active release migration baseline; refusing to apply migrations.');
    }
    const newlyCommitted = new Set(migrations.filter(({ name }) => !activeNames.has(name)).map(({ name }) => name));
    const unexpected = pending.filter((name) => !newlyCommitted.has(name));
    if (unexpected.length) {
      throw new Error(`Pending migrations are not new in this release: ${unexpected.join(', ')}.`);
    }
  }
} finally {
  await client.end();
}
