import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMilestoneCompletionByVisits } from '../src/utils/serviceLists.js';

test('milestone completion is trusted only when its repair order is in the caller-visible service history', () => {
  const completedForOtherTeam = {
    id: 'milestone-a',
    vehicleId: 'vehicle-a',
    status: 'completed',
    completedAt: new Date('2025-01-01T00:00:00Z'),
    completedByRepairOrderNo: 'RO-OTHER-TEAM',
  };
  const completedForCaller = {
    id: 'milestone-b',
    vehicleId: 'vehicle-b',
    status: 'completed',
    completedAt: new Date('2025-02-01T00:00:00Z'),
    completedByRepairOrderNo: 'RO-CURRENT-TEAM',
  };
  const pending = {
    id: 'milestone-c',
    vehicleId: 'vehicle-c',
    status: 'pending',
    completedAt: null,
    completedByRepairOrderNo: null,
  };

  const visible = filterMilestoneCompletionByVisits(
    [completedForOtherTeam, completedForCaller, pending],
    [
      { vehicleId: 'vehicle-a', workshopVisits: [{ repairOrderNo: 'RO-CURRENT-A' }] },
      { vehicleId: 'vehicle-b', workshopVisits: [{ repairOrderNo: 'RO-CURRENT-TEAM' }] },
      { vehicleId: 'vehicle-c', workshopVisits: [] },
    ],
  );

  assert.deepEqual(visible, [
    { ...completedForOtherTeam, status: 'pending', completedAt: null, completedByRepairOrderNo: null },
    completedForCaller,
    pending,
  ]);
});
