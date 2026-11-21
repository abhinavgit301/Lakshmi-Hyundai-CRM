import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('projection reconciliation pages include orphan IDs and compare each page in one snapshot', {
  skip: !databaseUrl, timeout: 30000,
}, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  const { prisma } = await import('../src/config/prisma.js');
  const { reconcileCreAssignmentProjectionPage } = await import('../src/utils/creAssignmentProjection.js');
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  const schema = `projection_page_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`
      CREATE TABLE "${schema}"."vehicles" ("id" text PRIMARY KEY, "ccmId" text);
      CREATE TABLE "${schema}"."master_call_lists" ("ccmId" text, "ownerUserId" text, "vehicleId" text);
      CREATE TABLE "${schema}"."allocations" ("ccmId" text, "creId" text, "vehicleId" text, "status" text);
      CREATE TABLE "${schema}"."cre_vehicle_assignment_projection" (
        "ccmId" text, "creId" text, "vehicleId" text, "fromMaster" boolean, "fromAllocation" boolean
      );
      INSERT INTO "${schema}"."vehicles" VALUES ('a', 'team'), ('b', 'team'), ('c', 'team');
      INSERT INTO "${schema}"."master_call_lists" VALUES
        ('team', 'cre', 'a'), ('team', 'cre', 'b'), ('team', 'cre', 'c');
      INSERT INTO "${schema}"."cre_vehicle_assignment_projection" VALUES
        ('team', 'cre', 'a', true, false), ('team', 'cre', 'b', false, true),
        ('team', 'other', 'b', true, false), ('team', 'cre', 'orphan', true, false);
    `);
    let afterSelection;
    const scopedDb = {
      $transaction: (work, options) => prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
        let selection = true;
        const scopedTransaction = new Proxy(transaction, {
          get(target, property) {
            if (property === '$queryRaw') return async (...args) => {
              const rows = await target.$queryRaw(...args);
              if (selection) {
                selection = false;
                await afterSelection?.();
              }
              return rows;
            };
            return Reflect.get(target, property, target);
          },
        });
        return work(scopedTransaction);
      }, options),
    };
    const first = await reconcileCreAssignmentProjectionPage(scopedDb, { limit: 2 });
    assert.deepEqual(first, {
      processed: 2, nextAfterId: 'b', hasMore: true,
      counts: { missing: '0', unexpected: '1', changed: '1' },
    });
    const second = await reconcileCreAssignmentProjectionPage(scopedDb, { afterId: first.nextAfterId, limit: 2 });
    assert.deepEqual(second, {
      processed: 2, nextAfterId: 'orphan', hasMore: false,
      counts: { missing: '1', unexpected: '1', changed: '0' },
    });
    assert.deepEqual(await reconcileCreAssignmentProjectionPage(scopedDb, { afterId: second.nextAfterId, limit: 2 }), {
      processed: 0, nextAfterId: 'orphan', hasMore: false,
      counts: { missing: '0', unexpected: '0', changed: '0' },
    });
    afterSelection = () => client.query(`UPDATE "${schema}"."master_call_lists" SET "ownerUserId" = 'other' WHERE "vehicleId" = 'a'`);
    assert.deepEqual(await reconcileCreAssignmentProjectionPage(scopedDb, { limit: 1 }), {
      processed: 1, nextAfterId: 'a', hasMore: true,
      counts: { missing: '0', unexpected: '0', changed: '0' },
    });
    afterSelection = undefined;
    assert.deepEqual((await reconcileCreAssignmentProjectionPage(scopedDb, { limit: 1 })).counts, {
      missing: '1', unexpected: '1', changed: '0',
    });
    await client.query(`
      INSERT INTO "${schema}"."cre_vehicle_assignment_projection"
      SELECT 'team', cre, 'z' || lpad(n::text, 4, '0'), true, false
      FROM generate_series(1, 501) n CROSS JOIN (VALUES ('cre-a'), ('cre-b')) cres(cre)
    `);
    const largePage = await reconcileCreAssignmentProjectionPage(scopedDb, { afterId: 'orphan', limit: 500 });
    assert.deepEqual(largePage, {
      processed: 500, nextAfterId: 'z0500', hasMore: true,
      counts: { missing: '0', unexpected: '1000', changed: '0' },
    });
    assert.deepEqual(await reconcileCreAssignmentProjectionPage(scopedDb, { afterId: largePage.nextAfterId, limit: 500 }), {
      processed: 1, nextAfterId: 'z0501', hasMore: false,
      counts: { missing: '0', unexpected: '2', changed: '0' },
    });
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
    await prisma.$disconnect();
  }
});
