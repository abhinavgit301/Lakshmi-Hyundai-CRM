import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeIneligibleFreeServiceFollowUps, filterMilestoneCompletionByVisits, syncFreeServiceMilestones } from '../src/utils/serviceLists.js';
import { snapshotInvalidationMock } from '../test-support/snapshotInvalidationMock.js';
import { isPerformanceAggregateMaintenanceEnabled } from '../src/utils/performanceSnapshotState.js';

test('visible early history completes only its chronological milestone, even with old persisted statuses', () => {
  const saleDate = new Date(2026, 9, 10);
  const visit = { id: 'early', repairOrderNo: 'RO-EARLY', visitDate: new Date(2026, 9, 31), importedDetails: { workType: 'Free Service' } };
  const rows = [
    { id: 'first', vehicleId: 'vehicle-a', milestone: 1, status: 'pending' },
    { id: 'second', vehicleId: 'vehicle-a', milestone: 2, status: 'completed', completedByWorkshopVisitId: 'early' },
  ];
  const visible = filterMilestoneCompletionByVisits(rows, [{ vehicleId: 'vehicle-a', saleDate, workshopVisits: [visit] }]);
  assert.equal(visible[0].status, 'completed');
  assert.equal(visible[0].completedByWorkshopVisitId, 'early');
  assert.equal(visible[1].status, 'pending');
  const hidden = filterMilestoneCompletionByVisits(rows, [{ vehicleId: 'vehicle-a', saleDate, workshopVisits: [] }]);
  assert.deepEqual(hidden.map((row) => row.status), ['pending', 'pending']);
});

test('an early visit completes the first milestone and leaves the second callable', async () => {
  const now = new Date();
  const saleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 45);
  const visitDate = new Date(saleDate.getFullYear(), saleDate.getMonth(), saleDate.getDate() + 21);
  const visit = { id: 'early', physicalVehicleId: 'pv', repairOrderNo: 'RO-EARLY', visitDate, importedDetails: { workType: 'Free Service' } };
  const existing = [1, 2, 3].map((milestone) => ({
    id: `milestone-${milestone}`, vehicleId: 'vehicle', milestone,
    dueDate: new Date(now.getFullYear(), now.getMonth() + milestone, now.getDate()),
    status: 'pending',
  }));
  const invalidation = {};
  const db = milestoneDatabase({
    findMany: async () => existing,
    createMany: async () => ({ count: 0 }),
    updateMany: async ({ where, data }) => { Object.assign(existing.find((row) => row.id === where.id), data); return { count: 1 }; },
  }, invalidation);
  await syncFreeServiceMilestones([{ id: 'vehicle', physicalVehicleId: 'pv', saleDate, workshopVisits: [visit] }], db);
  assert.deepEqual(existing.map((row) => row.status), ['completed', 'pending', 'pending']);
  assert.equal(existing[0].completedByWorkshopVisitId, 'early');

  const filter = await excludeIneligibleFreeServiceFollowUps({ source: 'FREE_SERVICE' }, { role: 'CCM', ccmId: 'ccm' }, {
    followUp: { findMany: async () => [
      { id: 'first', vehicle: { physicalVehicleId: 'pv', saleDate }, milestone: { milestone: 1, status: 'pending' } },
      { id: 'second', vehicle: { physicalVehicleId: 'pv', saleDate }, milestone: { milestone: 2, status: 'completed' } },
    ] },
    workshopVisit: { findMany: async () => [visit] },
  });
  assert.deepEqual(filter.AND, [{ id: { notIn: ['first'] } }]);
});

test('follow-up eligibility deduplicates repeated representations of one shared visit', async () => {
  const now = new Date();
  const saleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 45);
  const visit = {
    id: 'one-visit', physicalVehicleId: 'pv', visitDate: new Date(saleDate.getFullYear(), saleDate.getMonth(), saleDate.getDate() + 21),
    importedDetails: { workType: 'Free Service' },
  };
  let selectedFields;
  const filter = await excludeIneligibleFreeServiceFollowUps({ source: 'FREE_SERVICE' }, { role: 'CCM', ccmId: 'ccm' }, {
    followUp: { findMany: async () => [1, 2].map((milestone) => ({
      id: `follow-${milestone}`, vehicle: { physicalVehicleId: 'pv', saleDate }, milestone: { milestone },
    })) },
    workshopVisit: { findMany: async ({ select }) => { selectedFields = select; return [visit, { ...visit }]; } },
  });
  assert.equal(selectedFields.id, true);
  assert.deepEqual(filter.AND, [{ id: { notIn: ['follow-1'] } }]);
});

function milestoneDatabase(delegate, invalidation) {
  const db = { freeServiceMilestone: delegate, ...snapshotInvalidationMock(invalidation) };
  db.$transaction = async (callback) => callback(db);
  return db;
}

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
  const invalidation = {};
  const db = milestoneDatabase({
      findMany: async () => created || [],
      createMany: async ({ data }) => { created = data; return { count: data.length }; },
      updateMany: async () => ({ count: 0 }),
  }, invalidation);
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
  if (isPerformanceAggregateMaintenanceEnabled()) assert.equal(invalidation.revisions.global, 1);
});

test('re-import preserves existing milestone dates and completes against the saved date', async () => {
  const savedDueDate = new Date(2025, 2, 1);
  const updates = [];
  const invalidation = {};
  const existing = [{
    id: 'milestone-existing',
    vehicleId: 'vehicle-a',
    milestone: 1,
    dueDate: savedDueDate,
    status: 'pending',
  }];
  const db = milestoneDatabase({
      findMany: async () => existing,
      createMany: async ({ data }) => ({ count: data.length }),
      updateMany: async (args) => { updates.push(args); return { count: 1 }; },
  }, invalidation);
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
  if (isPerformanceAggregateMaintenanceEnabled()) assert.equal(invalidation.revisions.global, 1);
});

test('a grace-period free service completes a pending milestone and is not recreated as callable', async () => {
  const dueDate = new Date(2025, 2, 1);
  const updates = [];
  const invalidation = {};
  const existing = [{
    id: 'milestone-grace',
    vehicleId: 'vehicle-a',
    milestone: 1,
    dueDate,
    status: 'pending',
  }];
  const db = milestoneDatabase({
      findMany: async () => existing,
      createMany: async ({ data }) => ({ count: data.length }),
      updateMany: async (args) => {
        updates.push(args);
        existing[0] = { ...existing[0], ...args.data };
        return { count: 1 };
      },
  }, invalidation);
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
  if (isPerformanceAggregateMaintenanceEnabled()) assert.equal(invalidation.revisions.global, 1);
});

test('a concurrent completion is not overwritten or reported as a new update', async (t) => {
  const previous = process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
  const previousEnabled = process.env.PERFORMANCE_AGGREGATES_ENABLED;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  process.env.PERFORMANCE_AGGREGATES_ENABLED = 'false';
  t.after(() => {
    if (previous === undefined) delete process.env.PERFORMANCE_AGGREGATES_MAINTAIN;
    else process.env.PERFORMANCE_AGGREGATES_MAINTAIN = previous;
    if (previousEnabled === undefined) delete process.env.PERFORMANCE_AGGREGATES_ENABLED;
    else process.env.PERFORMANCE_AGGREGATES_ENABLED = previousEnabled;
  });
  const row = { id: 'm1', vehicleId: 'v1', milestone: 1, status: 'pending', dueDate: new Date(2025, 2, 1) };
  const invalidation = {};
  const db = milestoneDatabase({
    findMany: async () => [{ ...row }],
    createMany: async () => ({ count: 0 }),
    updateMany: async ({ where, data }) => {
      Object.assign(row, { status: 'completed', completedByWorkshopVisitId: 'concurrent' });
      if (row.id !== where.id || row.status !== where.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  }, invalidation);
  const rows = await syncFreeServiceMilestones([{
    id: 'v1', physicalVehicleId: 'pv1', saleDate: new Date(2025, 0, 1),
    workshopVisits: [{ id: 'old', repairOrderNo: 'RO', visitDate: new Date(2025, 2, 1), importedDetails: { workType: 'Free Service' } }],
  }], db);
  assert.equal(rows[0].completedByWorkshopVisitId, 'concurrent');
  assert.equal(invalidation.revisions.global, 0);
  assert.equal(invalidation.snapshotUpdates.length, 0);
});

for (const maintenance of [false, true]) {
  test(`milestone updates are ${maintenance ? 'transactional' : 'bounded parallel'} with maintenance ${maintenance ? 'on' : 'off'}`, async (t) => {
    for (const [name, value] of Object.entries({
      PERFORMANCE_AGGREGATES_ENABLED: 'false',
      PERFORMANCE_AGGREGATES_MAINTAIN: String(maintenance),
    })) {
      const previous = process.env[name];
      process.env[name] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
    }
    let active = 0;
    let maximum = 0;
    const invalidation = {};
    const dueDate = new Date(2025, 2, 1);
    const existing = Array.from({ length: 45 }, (_, i) => ({
      id: `milestone-${i}`, vehicleId: `vehicle-${i}`, milestone: 1, dueDate, status: 'pending',
    }));
    const db = milestoneDatabase({
      findMany: async () => existing,
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ where, data }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        Object.assign(existing.find((entry) => entry.id === where.id), data);
        active -= 1;
        return { count: 1 };
      },
    }, invalidation);
    const vehicles = existing.map(({ vehicleId }) => ({
      id: vehicleId,
      saleDate: new Date(2025, 0, 1),
      workshopVisits: [{
        id: `visit-${vehicleId}`, repairOrderNo: `ro-${vehicleId}`, visitDate: new Date(2025, 2, 10),
        importedDetails: { workType: 'Free Service' },
      }],
    }));
    await syncFreeServiceMilestones(vehicles, db);
    assert.equal(maximum, maintenance ? 1 : 20);
    assert.equal(existing.filter((entry) => entry.status === 'completed').length, 45);
    if (maintenance) assert.equal(invalidation.revisions.global, 1);
  });
}
