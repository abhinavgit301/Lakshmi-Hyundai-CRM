import test from 'node:test';
import assert from 'node:assert/strict';
import { findMissedWarrantyCases } from '../src/utils/serviceLists.js';

test('missed warranty reads bounded, scoped batches and keeps answered-call classification', async () => {
  const vehicles = Array.from({ length: 1001 }, (_, index) => ({
    id: `vehicle-${index}`, vin: `vin-${index}`, saleDate: new Date(2023, 5, 15),
    registrationNumber: null, customer: { fullName: 'Customer' },
  }));
  const reads = [];
  const db = {
    vehicle: { findMany: async ({ where }) => {
      assert.equal(where.ccmId, 'team');
      return vehicles;
    } },
    callLog: { findMany: async ({ where }) => {
      reads.push(where);
      return where.vehicleId.in.includes('vehicle-1000') ? [{
        vehicleId: 'vehicle-1000', outcome: 'CONTACTED',
        callSource: 'WARRANTY', createdAt: new Date(2026, 5, 1),
      }] : [];
    } },
  };
  const missed = await findMissedWarrantyCases({
    scope: { ccmId: 'team' }, vehicleScope: { ccmId: 'team' },
    callScope: { ccmId: 'team' }, year: 2026, month: 6,
    now: new Date(2026, 6, 1), timeZone: 'Asia/Kolkata', db,
  });
  assert.deepEqual(reads.map((where) => where.vehicleId.in.length), [500, 500, 1]);
  assert.ok(reads.every((where) => where.ccmId === 'team' && where.callSource === 'WARRANTY'));
  assert.equal(missed.length, 1000);
  assert.ok(missed.every(({ vehicleId }) => vehicleId !== 'vehicle-1000'));
});

test('missed warranty classifies each call batch before loading the next and preserves first vehicle ordering', async () => {
  const vehicles = Array.from({ length: 501 }, (_, index) => ({
    id: `vehicle-${index}`, vin: `vin-${index}`, saleDate: new Date(2023, 5, 15),
    registrationNumber: null, customer: { fullName: 'Customer' },
  }));
  let classified = false;
  let reads = 0;
  const db = {
    vehicle: { findMany: async () => [vehicles[0], ...vehicles] },
    callLog: { findMany: async () => {
      reads += 1;
      if (reads === 2) {
        assert.equal(classified, true);
        return [];
      }
      return [{
        vehicleId: 'vehicle-0', callSource: 'WARRANTY', createdAt: new Date(2026, 5, 1),
        get outcome() { classified = true; return 'CONTACTED'; },
      }];
    } },
  };
  const missed = await findMissedWarrantyCases({
    scope: {}, year: 2026, month: 6, now: new Date(2026, 6, 1), timeZone: 'Asia/Kolkata', db,
  });
  assert.equal(reads, 2);
  assert.equal(missed.length, 500);
  assert.deepEqual(missed.map(({ vehicleId }) => vehicleId), vehicles.slice(1).map(({ id }) => id));
});

test('missed warranty propagates an error from a later call batch', async () => {
  const error = new Error('call query failed');
  let reads = 0;
  const db = {
    vehicle: { findMany: async () => Array.from({ length: 501 }, (_, index) => ({
      id: `vehicle-${index}`, saleDate: new Date(2023, 5, 15),
    })) },
    callLog: { findMany: async () => { if (++reads === 2) throw error; return []; } },
  };
  await assert.rejects(findMissedWarrantyCases({
    scope: {}, year: 2026, month: 6, now: new Date(2026, 6, 1), timeZone: 'Asia/Kolkata', db,
  }), (actual) => actual === error);
});
