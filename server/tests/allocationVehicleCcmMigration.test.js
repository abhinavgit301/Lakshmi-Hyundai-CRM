import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

let PGlite = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  PGlite = null;
}

const migrationSql = readFileSync(
  new URL('../prisma/migrations/20261120000001_allocation_vehicle_ccm_fk/migration.sql', import.meta.url),
  'utf8',
);

async function createDatabase({ mismatchedAllocation = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "vehicles" (
      "id" TEXT PRIMARY KEY,
      "ccmId" TEXT NOT NULL,
      CONSTRAINT "vehicles_id_ccmId_key" UNIQUE ("id", "ccmId")
    );
    CREATE TABLE "allocations" (
      "id" TEXT PRIMARY KEY,
      "vehicleId" TEXT NOT NULL,
      "ccmId" TEXT NOT NULL,
      CONSTRAINT "allocations_vehicleId_fkey"
        FOREIGN KEY ("vehicleId") REFERENCES "vehicles" ("id")
    );
    INSERT INTO "vehicles" VALUES ('vehicle-a', 'ccm-a');
    ${mismatchedAllocation
      ? `INSERT INTO "allocations" VALUES ('allocation-a', 'vehicle-a', 'ccm-b');`
      : `INSERT INTO "allocations" VALUES ('allocation-a', 'vehicle-a', 'ccm-a');`}
  `);
  return db;
}

test('migration replaces the vehicle FK with a vehicle-and-CCM invariant', { skip: !PGlite }, async () => {
  const db = await createDatabase();
  try {
    await db.exec(migrationSql);
    await db.exec(`INSERT INTO "allocations" VALUES ('allocation-b', 'vehicle-a', 'ccm-a')`);
    await assert.rejects(
      db.exec(`INSERT INTO "allocations" VALUES ('allocation-c', 'vehicle-a', 'ccm-b')`),
      /allocations_vehicleId_ccmId_fkey/,
    );
  } finally {
    await db.close();
  }
});

test('migration refuses existing mismatches without dropping the prior FK', { skip: !PGlite }, async () => {
  const db = await createDatabase({ mismatchedAllocation: true });
  try {
    await assert.rejects(db.exec(migrationSql), /reconcile mismatched allocations/);
    await db.exec('ROLLBACK');
    const constraints = await db.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = '"allocations"'::regclass
      ORDER BY conname
    `);
    assert.deepEqual(constraints.rows.map(({ conname }) => conname), [
      'allocations_pkey',
      'allocations_vehicleId_fkey',
    ]);
  } finally {
    await db.close();
  }
});
