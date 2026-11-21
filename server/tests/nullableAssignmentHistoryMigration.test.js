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
  new URL('../prisma/migrations/20261121000000_nullable_unlinked_assignment_history/migration.sql', import.meta.url),
  'utf8',
);
const candidateSchema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

test('candidate schema declares history vehicleId nullable', () => {
  const model = candidateSchema.match(/model CreAssignmentHistory \{([\s\S]*?)\n\}/);
  assert.ok(model, 'candidate schema must define CreAssignmentHistory');
  assert.match(model[1], /^\s*vehicleId\s+String\?\s*$/m);
});

test('migration only drops the history vehicleId NOT NULL constraint', () => {
  const sql = migrationSql.replace(/--[^\r\n]*/g, '').trim();
  assert.match(sql, /^ALTER TABLE "cre_assignment_history" ALTER COLUMN "vehicleId" DROP NOT NULL;$/);
});

test('nullable-history migration preserves existing events and permits unlinked events', { skip: !PGlite }, async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "cre_assignment_history" (
        "id" TEXT PRIMARY KEY,
        "vehicleId" TEXT NOT NULL,
        "ccmId" TEXT NOT NULL,
        "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX "cre_assignment_history_vehicleId_effectiveAt_idx"
        ON "cre_assignment_history" ("vehicleId", "effectiveAt");
      INSERT INTO "cre_assignment_history" ("id", "vehicleId", "ccmId")
      VALUES ('linked-event', 'vehicle-1', 'ccm-1');
    `);

    await db.exec(migrationSql);
    await db.exec(migrationSql);
    await db.exec(`
      INSERT INTO "cre_assignment_history" ("id", "vehicleId", "ccmId")
      VALUES ('unlinked-event', NULL, 'ccm-1');
    `);

    const column = await db.query(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'cre_assignment_history' AND column_name = 'vehicleId'
    `);
    assert.equal(column.rows[0].is_nullable, 'YES');

    const events = await db.query(`
      SELECT "id", "vehicleId", "ccmId"
      FROM "cre_assignment_history"
      ORDER BY "id"
    `);
    assert.deepEqual(events.rows, [
      { id: 'linked-event', vehicleId: 'vehicle-1', ccmId: 'ccm-1' },
      { id: 'unlinked-event', vehicleId: null, ccmId: 'ccm-1' },
    ]);

    const indexes = await db.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'cre_assignment_history'
      ORDER BY indexname
    `);
    assert.deepEqual(indexes.rows.map(({ indexname }) => indexname), [
      'cre_assignment_history_pkey',
      'cre_assignment_history_vehicleId_effectiveAt_idx',
    ]);
  } finally {
    await db.close();
  }
});
