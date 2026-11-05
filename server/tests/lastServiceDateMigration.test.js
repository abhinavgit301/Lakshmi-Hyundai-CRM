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
  new URL('../prisma/migrations/20261112000000_physical_vehicle_last_service_date/migration.sql', import.meta.url),
  'utf8',
);

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "physical_vehicles" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "workshop_visits" (
      "id" TEXT PRIMARY KEY,
      "physicalVehicleId" TEXT NOT NULL,
      "ccmId" TEXT,
      "visitDate" TIMESTAMP(3)
    );
    INSERT INTO "physical_vehicles" ("id") VALUES ('pv1'), ('pv2'), ('pv3'), ('pv4');
    INSERT INTO "workshop_visits" ("id","physicalVehicleId","ccmId","visitDate") VALUES
      ('a1','pv1','ccm-a','2025-01-10 00:00:00'),
      ('a2','pv1','ccm-b','2025-06-20 00:00:00'),
      ('a3','pv1','ccm-a',NULL),
      ('b1','pv2','ccm-a',NULL),
      ('c1','pv3','ccm-a','2027-01-01 00:00:00'),
      ('c2','pv3','ccm-a','2025-03-03 00:00:00');
  `);
  await db.exec(migrationSql);
  return db;
}

const lastDate = async (db, id) => {
  const result = await db.query(`SELECT to_char("lastServiceDate", 'YYYY-MM-DD') AS d FROM "physical_vehicles" WHERE "id" = $1`, [id]);
  return result.rows[0].d;
};

test('migration backfill, trigger maintenance and CCM-shared visits', { skip: !PGlite }, async () => {
  const db = await createDatabase();
  try {
    // Backfill: max over all dated visits regardless of ccmId; null dates ignored; no visits -> null.
    assert.equal(await lastDate(db, 'pv1'), '2025-06-20');
    assert.equal(await lastDate(db, 'pv2'), null);
    assert.equal(await lastDate(db, 'pv3'), '2027-01-01');
    assert.equal(await lastDate(db, 'pv4'), null);

    // Insert of a newer visit (import).
    await db.exec(`INSERT INTO "workshop_visits" VALUES ('a4','pv1','ccm-b','2025-09-09 00:00:00')`);
    assert.equal(await lastDate(db, 'pv1'), '2025-09-09');

    // Insert of an older visit must not lower it.
    await db.exec(`INSERT INTO "workshop_visits" VALUES ('a5','pv1','ccm-a','2024-01-01 00:00:00')`);
    assert.equal(await lastDate(db, 'pv1'), '2025-09-09');

    // Import rollback / deletion of the newest visit falls back to the next latest.
    await db.exec(`DELETE FROM "workshop_visits" WHERE "id" = 'a4'`);
    assert.equal(await lastDate(db, 'pv1'), '2025-06-20');

    // Bulk delete of all dated visits leaves null.
    await db.exec(`DELETE FROM "workshop_visits" WHERE "physicalVehicleId" = 'pv3'`);
    assert.equal(await lastDate(db, 'pv3'), null);

    // Date correction.
    await db.exec(`UPDATE "workshop_visits" SET "visitDate" = '2025-12-31 00:00:00' WHERE "id" = 'a1'`);
    assert.equal(await lastDate(db, 'pv1'), '2025-12-31');
    await db.exec(`UPDATE "workshop_visits" SET "visitDate" = NULL WHERE "id" = 'a1'`);
    assert.equal(await lastDate(db, 'pv1'), '2025-06-20');

    // Moving a visit between physical vehicles refreshes both.
    await db.exec(`UPDATE "workshop_visits" SET "physicalVehicleId" = 'pv4' WHERE "id" = 'a2'`);
    assert.equal(await lastDate(db, 'pv4'), '2025-06-20');
    assert.equal(await lastDate(db, 'pv1'), '2024-01-01');

    // Updating an unrelated column leaves the value untouched.
    await db.exec(`UPDATE "workshop_visits" SET "ccmId" = 'ccm-z' WHERE "id" = 'a5'`);
    assert.equal(await lastDate(db, 'pv1'), '2024-01-01');
  } finally {
    await db.close();
  }
});

test('migration rollback statements restore the previous schema', { skip: !PGlite }, async () => {
  const db = await createDatabase();
  try {
    await db.exec(`
      DROP TRIGGER "workshop_visits_refresh_last_service_date" ON "workshop_visits";
      DROP FUNCTION refresh_physical_vehicle_last_service_date();
      DROP INDEX "physical_vehicles_lastServiceDate_idx";
      ALTER TABLE "physical_vehicles" DROP COLUMN "lastServiceDate";
    `);
    const columns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'physical_vehicles'`);
    assert.deepEqual(columns.rows.map((row) => row.column_name), ['id']);
  } finally {
    await db.close();
  }
});
