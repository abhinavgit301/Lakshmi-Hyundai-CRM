import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMilestoneCompletionByVisits, syncFreeServiceMilestones } from '../src/utils/serviceLists.js';

test('milestone completion is trusted only when its repair order is in the caller-visible service history', () => {
  const completedForOtherTeam = {
    id: 'milestone-a',
    vehicleId: 'vehicle-a',
    status: 'completed',
    completedAt: new Date('2025-01-01T00:00:00Z'),
    completedByRepairOrderNo: 'RO-OTHER-TEAM',
    completedByWorkshopVisitId: 'visit-hidden',
  };
  const completedForCaller = {
    id: 'milestone-b',
    vehicleId: 'vehicle-b',
    status: 'completed',
    completedAt: new Date('2025-02-01T00:00:00Z'),
    completedByRepairOrderNo: 'RO-CURRENT-TEAM',
    completedByWorkshopVisitId: 'visit-visible',
  };
  const pending = {
    id: 'milestone-c',
    vehicleId: 'vehicle-c',
    status: 'pending',
    completedAt: null,
    completedByRepairOrderNo: null,
    completedByWorkshopVisitId: null,
  };

  const visible = filterMilestoneCompletionByVisits(
    [completedForOtherTeam, completedForCaller, pending],
    [
      { vehicleId: 'vehicle-a', workshopVisits: [{ id: 'visit-current', repairOrderNo: 'RO-CURRENT-A' }] },
      { vehicleId: 'vehicle-b', workshopVisits: [{ id: 'visit-visible', repairOrderNo: 'RO-CURRENT-TEAM' }] },
      { vehicleId: 'vehicle-c', workshopVisits: [] },
    ],
  );

  assert.deepEqual(visible, [
    {
      ...completedForOtherTeam,
      status: 'pending',
      completedAt: null,
      completedByRepairOrderNo: null,
      completedByWorkshopVisitId: null,
    },
    completedForCaller,
    pending,
  ]);
});

test('milestone completion follows the exact visit ID rather than an RO-number match', () => {
  const milestone = {
    id: 'milestone-exact',
    vehicleId: 'vehicle-a',
    status: 'completed',
    completedAt: new Date('2025-03-01T00:00:00Z'),
    completedByRepairOrderNo: 'RO-55',
    completedByWorkshopVisitId: 'visit-selected',
  };
  const visible = filterMilestoneCompletionByVisits([milestone], [{
    vehicleId: 'vehicle-a',
    workshopVisits: [
      { id: 'visit-other', repairOrderNo: 'RO-55' },
      { id: 'visit-selected', repairOrderNo: 'RO-55' },
    ],
  }]);

  assert.deepEqual(visible, [milestone]);
  const hidden = filterMilestoneCompletionByVisits([milestone], [{
    vehicleId: 'vehicle-a',
    workshopVisits: [{ id: 'visit-other', repairOrderNo: 'RO-55' }],
  }]);
  assert.equal(hidden[0].status, 'pending');
  assert.equal(hidden[0].completedByWorkshopVisitId, null);
});

test('ambiguous legacy repair-order milestone references are not treated as verified completion', () => {
  const milestone = {
    id: 'milestone-legacy',
    vehicleId: 'vehicle-a',
    status: 'completed',
    completedAt: new Date('2025-03-01T00:00:00Z'),
    completedByRepairOrderNo: 'ro 55',
    completedByWorkshopVisitId: null,
  };
  const visible = filterMilestoneCompletionByVisits([milestone], [{
    vehicleId: 'vehicle-a',
    workshopVisits: [
      { id: 'visit-a', repairOrderNo: 'RO 55' },
      { id: 'visit-b', repairOrderNo: ' ro  55 ' },
    ],
  }]);
  assert.equal(visible[0].status, 'pending');
});

test('new milestone completions store the exact completing WorkshopVisit ID', async () => {
  let created;
  const db = {
    freeServiceMilestone: {
      findMany: async () => created || [],
      createMany: async ({ data }) => { created = data; },
      update: async () => {},
    },
  };
  await syncFreeServiceMilestones([{
    id: 'vehicle-a',
    saleDate: new Date('2025-01-01T00:00:00Z'),
    workshopVisits: [{
      id: 'visit-a',
      repairOrderNo: 'RO-FREE-1',
      visitDate: new Date('2025-03-01T00:00:00Z'),
      importedDetails: { workType: 'Free Service' },
    }],
  }], db);

  const completed = created.find(({ status }) => status === 'completed');
  assert.equal(completed.completedByRepairOrderNo, 'RO-FREE-1');
  assert.equal(completed.completedByWorkshopVisitId, 'visit-a');
});
