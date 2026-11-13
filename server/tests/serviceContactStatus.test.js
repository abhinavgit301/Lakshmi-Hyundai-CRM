import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveServiceContactStatus,
  saveServiceContactStatus,
  serviceCohortKey,
  statusForServiceCall,
} from '../src/utils/serviceContactStatus.js';
import {
  compareByServiceStatusThenDueDate,
  decodeDueCursor,
  paginateByCursor,
} from '../src/utils/pagination.js';

test('service outcomes update only the intended status', () => {
  for (const outcome of ['CONTACTED', 'NOT_INTERESTED', 'OTHER']) {
    assert.equal(statusForServiceCall(outcome, null), 'contacted');
  }
  for (const outcome of ['NO_RESPONSE', 'WRONG_NUMBER', 'APPOINTMENT_SET']) {
    assert.equal(statusForServiceCall(outcome, null), null);
  }
  assert.equal(statusForServiceCall('FOLLOW_UP_LATER', new Date()), 'follow-up');
  assert.equal(statusForServiceCall('CALLBACK', new Date()), 'follow-up');
});

test('new cohorts reset earlier statuses and master status matches the active cohort', () => {
  const now = new Date(2026, 10, 14);
  const vehicle = { serviceContactStatus: 'appointment', serviceStatusCohort: serviceCohortKey('6m', now) };
  assert.equal(resolveServiceContactStatus(vehicle, '6m', now), 'appointment');
  assert.equal(resolveServiceContactStatus(vehicle, '1y', now), 'pending');
  assert.equal(resolveServiceContactStatus(vehicle, '6m', new Date(2026, 11, 1)), 'pending');
  assert.equal(resolveServiceContactStatus(vehicle, null, now), 'appointment');
  assert.equal(resolveServiceContactStatus({}, '6m', now), 'pending');
  assert.equal(resolveServiceContactStatus({ serviceContactStatus: 'appointment' }, '6m', now), 'pending');
});

test('status updates classify the vehicle using shared visible history', async () => {
  const now = new Date(2026, 10, 14, 12);
  let write;
  const db = {
    vehicle: {
      findFirst: async (args) => {
        assert.deepEqual(args.where, { id: 'vehicle', ccmId: 'team' });
        assert.ok(args.select.physicalVehicle.select.workshopVisits.where.physicalVehicle);
        return {
          saleDate: null,
          physicalVehicle: { workshopVisits: [{ visitDate: new Date(2026, 4, 5), importedDetails: { workType: 'Paid Service' } }] },
        };
      },
      update: async (args) => { write = args; },
    },
  };
  await saveServiceContactStatus(db, {
    vehicleId: 'vehicle', ccmId: 'team', user: { role: 'CCM', ccmId: 'team' }, status: 'follow-up', now,
  });
  assert.deepEqual(write.data, { serviceContactStatus: 'follow-up', serviceStatusCohort: '6m:2026-11' });
});

test('50 pending, 7 contacted, 10 follow-ups and 6 appointments sort before cursor pagination', () => {
  const groups = [['appointment', 6], ['follow-up', 10], ['contacted', 7], ['pending', 50]];
  const records = groups.flatMap(([status, count]) => Array.from({ length: count }, (_, index) => ({
    id: `${status}-${index}`, status, dueDate: new Date(2026, 10, 15),
  }))).sort(compareByServiceStatusThenDueDate);
  const first = records.slice(0, 50);
  assert.ok(first.every(({ status }) => status === 'pending'));
  const cursor = decodeDueCursor(Buffer.from(JSON.stringify([first.at(-1).dueDate.toISOString(), first.at(-1).id, first.at(-1).status])).toString('base64url'));
  const next = paginateByCursor(records, { limit: 50, cursor, statusOrdering: true });
  assert.deepEqual(next.records.map(({ status }) => status), [
    ...Array(7).fill('contacted'), ...Array(10).fill('follow-up'), ...Array(6).fill('appointment'),
  ]);
  assert.equal(next.total, 73);
});
