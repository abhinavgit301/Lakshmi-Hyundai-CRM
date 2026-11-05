import assert from 'node:assert/strict';
import test from 'node:test';
import { findOrCreatePhysicalVehicle } from '../src/utils/physicalVehicle.js';

function fakeTransaction(existing) {
  const calls = [];
  return {
    calls,
    $queryRaw: async () => [],
    physicalVehicle: {
      findUnique: async (args) => { calls.push(['findUnique', args]); return existing; },
      create: async (args) => { calls.push(['create', args]); return { id: 'new', vin: args.data.vin }; },
    },
  };
}

test('findOrCreatePhysicalVehicle selects only id and vin so it works before the lastServiceDate migration', async () => {
  const found = fakeTransaction({ id: 'pv1', vin: 'VIN1' });
  assert.deepEqual(await findOrCreatePhysicalVehicle(found, 'vin1'), { id: 'pv1', vin: 'VIN1' });
  assert.deepEqual(found.calls[0][1].select, { id: true, vin: true });

  const created = fakeTransaction(null);
  await findOrCreatePhysicalVehicle(created, 'vin2');
  assert.deepEqual(created.calls.map(([name]) => name), ['findUnique', 'create']);
  for (const [, args] of created.calls) assert.deepEqual(args.select, { id: true, vin: true });
});
