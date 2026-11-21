import test from 'node:test';
import assert from 'node:assert/strict';
import { readCreAssignmentInventory } from '../src/utils/creAssignmentInventory.js';
import { creAssignmentSourceSql } from '../src/utils/creAssignmentSource.js';

test('assignment inventory returns exact string counts without exposing identifiers', async () => {
  let sql;
  const result = await readCreAssignmentInventory({
    $queryRaw: async (parts) => {
      sql = parts.join('?');
      return [{
        vehicleLinks: 9007199254740993n, customerLinks: 2n,
        masterOnly: 1n, allocationOnly: 1n, bothSources: 0n,
        ownedUnlinkedMasterEntries: 1n, crossTeamActiveAllocations: 0n,
      }];
    },
  });
  assert.equal(result.vehicleLinks, '9007199254740993');
  assert.equal(result.customerLinks, '2');
  assert.match(sql, /WITH links AS/);
  assert.match(creAssignmentSourceSql.sql, /"ownerUserId" IS NOT NULL/);
  assert.match(creAssignmentSourceSql.sql, /"status" = 'assigned'/);
  assert.match(creAssignmentSourceSql.sql, /v\."ccmId" = a\."ccmId"/);
  assert.deepEqual(Object.keys(result), [
    'vehicleLinks', 'customerLinks', 'masterOnly', 'allocationOnly', 'bothSources',
    'ownedUnlinkedMasterEntries', 'crossTeamActiveAllocations',
  ]);
});

test('inventory does not suppress database errors', async () => {
  const error = new Error('database unavailable');
  await assert.rejects(readCreAssignmentInventory({ $queryRaw: async () => { throw error; } }), (actual) => actual === error);
});
