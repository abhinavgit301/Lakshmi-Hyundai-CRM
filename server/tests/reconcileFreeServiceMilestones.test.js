import test from 'node:test';
import assert from 'node:assert/strict';
import { planFreeServiceReconciliation } from '../src/utils/reconcileFreeServiceMilestones.js';

test('reconciliation moves a stale completion to the next unexpired milestone without changing due dates', () => {
  const visit = { id: 'visit', repairOrderNo: 'RO', visitDate: new Date(2025, 5, 11), importedDetails: { workType: 'Free Service' } };
  const vehicle = {
    saleDate: new Date(2025, 0, 10),
    physicalVehicle: { workshopVisits: [visit] },
    freeServiceMilestones: [
      { id: 'first', milestone: 1, status: 'completed', completedAt: visit.visitDate, completedByWorkshopVisitId: visit.id, completedByRepairOrderNo: 'RO' },
      { id: 'second', milestone: 2, status: 'pending' },
      { id: 'third', milestone: 3, status: 'pending' },
    ],
  };
  const plan = planFreeServiceReconciliation(vehicle, new Date(2025, 5, 12));
  assert.equal(plan.error, null);
  assert.deepEqual(plan.updates, [
    { id: 'first', data: { status: 'pending', completedAt: null, completedByRepairOrderNo: null, completedByWorkshopVisitId: null } },
    { id: 'second', data: { status: 'completed', completedAt: visit.visitDate, completedByRepairOrderNo: 'RO', completedByWorkshopVisitId: 'visit' } },
  ]);
});

test('reconciliation refuses ambiguous fallback sale dates and unknown milestone states', () => {
  const vehicle = {
    saleDate: null,
    physicalVehicle: { workshopVisits: [
      { importedDetails: { saleDate: '2025-01-01' } },
      { importedDetails: { saleDate: '2025-02-01' } },
    ] },
    freeServiceMilestones: [{ id: 'first', milestone: 1, status: 'pending' }],
  };
  assert.equal(planFreeServiceReconciliation(vehicle, new Date(2026, 0, 1)).error, 'missing or ambiguous sale date');
  vehicle.saleDate = new Date(2025, 0, 1);
  vehicle.freeServiceMilestones[0].status = 'unknown';
  assert.equal(planFreeServiceReconciliation(vehicle, new Date(2026, 0, 1)).error, 'unsupported milestone or status');
});

test('a future stored sale date is not silently replaced by an imported sale date', () => {
  const vehicle = {
    saleDate: new Date(2027, 0, 1),
    physicalVehicle: { workshopVisits: [{
      id: 'visit',
      visitDate: new Date(2025, 2, 1),
      importedDetails: { saleDate: '2025-01-01', workType: 'Free Service' },
    }] },
    freeServiceMilestones: [{ id: 'first', milestone: 1, status: 'pending' }],
  };
  const plan = planFreeServiceReconciliation(vehicle, new Date(2026, 0, 1));
  assert.equal(plan.error, 'invalid or future stored sale date');
  assert.deepEqual(plan.updates, []);
});
