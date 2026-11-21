import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

let PGlite = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  PGlite = null;
}

const createMigrationSql = readFileSync(
  new URL('../prisma/migrations/20261112000000_physical_vehicle_last_service_date/migration.sql', import.meta.url),
  'utf8',
);
const removalMigrationSql = readFileSync(
  new URL('../prisma/migrations/20261120000002_remove_unused_physical_vehicle_last_service_date/migration.sql', import.meta.url),
  'utf8',
);

test('removal migration drops only the unused derived field and its maintenance objects', { skip: !PGlite }, async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "physical_vehicles" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "workshop_visits" (
        "id" TEXT PRIMARY KEY,
        "physicalVehicleId" TEXT NOT NULL,
        "ccmId" TEXT,
        "visitDate" TIMESTAMP(3)
      );
      INSERT INTO "physical_vehicles" ("id") VALUES ('pv1');
      INSERT INTO "workshop_visits" VALUES ('visit1', 'pv1', 'ccm-a', '2025-01-01 00:00:00');
    `);
    await db.exec(createMigrationSql);
    await db.exec(removalMigrationSql);

    const columns = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'physical_vehicles'
      ORDER BY ordinal_position
    `);
    assert.deepEqual(columns.rows.map(({ column_name }) => column_name), ['id']);

    const source = await db.query(`SELECT COUNT(*)::int AS count FROM "workshop_visits"`);
    assert.equal(source.rows[0].count, 1);
    const triggers = await db.query(`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = '"workshop_visits"'::regclass
        AND NOT tgisinternal
    `);
    assert.deepEqual(triggers.rows, []);
  } finally {
    await db.close();
  }
});
