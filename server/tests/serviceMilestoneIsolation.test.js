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

test('re-import preserves existing milestone dates and completes against the saved date', async () => {
  const savedDueDate = new Date(2025, 2, 1);
  const updates = [];
  const existing = [{
    id: 'milestone-existing',
    vehicleId: 'vehicle-a',
    milestone: 1,
    dueDate: savedDueDate,
    status: 'pending',
  }];
  const db = {
    freeServiceMilestone: {
      findMany: async () => existing,
      createMany: async () => {},
      update: async (args) => { updates.push(args); },
    },
  };
  await syncFreeServiceMilestones([{
    id: 'vehicle-a',
    saleDate: new Date(2025, 1, 1),
    physicalVehicleId: 'physical-a',
    workshopVisits: [{
      id: 'visit-a',
      repairOrderNo: 'RO-FREE-1',
      visitDate: new Date(2025, 2, 10),
      importedDetails: { workType: 'Free Service' },
    }],
  }], db);

  assert.equal(updates.length, 1);
  assert.equal(Object.hasOwn(updates[0].data, 'dueDate'), false);
  assert.equal(updates[0].data.status, 'completed');
  assert.equal(updates[0].where.id, 'milestone-existing');
});

test('a grace-period free service completes a pending milestone and is not recreated as callable', async () => {
  const dueDate = new Date(2025, 2, 1);
  const updates = [];
  const existing = [{
    id: 'milestone-grace',
    vehicleId: 'vehicle-a',
    milestone: 1,
    dueDate,
    status: 'pending',
  }];
  const db = {
    freeServiceMilestone: {
      findMany: async () => existing,
      createMany: async () => {},
      update: async (args) => {
        updates.push(args);
        existing[0] = { ...existing[0], ...args.data };
      },
    },
  };
  const freeServiceVisit = {
    id: 'visit-in-grace',
    repairOrderNo: 'RO-GRACE',
    visitDate: new Date(2025, 4, 1),
    importedDetails: { workType: 'Free Service' },
  };
  const milestones = await syncFreeServiceMilestones([{
    id: 'vehicle-a',
    saleDate: new Date(2025, 0, 1),
    physicalVehicleId: 'physical-a',
    workshopVisits: [freeServiceVisit],
  }], db);

  assert.equal(updates.length, 1);
  assert.equal(milestones[0].status, 'completed');
  assert.equal(milestones[0].completedByWorkshopVisitId, 'visit-in-grace');
  assert.deepEqual(milestones.filter((milestone) => milestone.status === 'pending'), []);
});
