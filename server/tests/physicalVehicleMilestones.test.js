import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePhysicalVehicleMilestones } from '../src/utils/physicalVehicleMilestones.js';
import { snapshotInvalidationMock } from '../test-support/snapshotInvalidationMock.js';
import { isPerformanceAggregateMaintenanceEnabled } from '../src/utils/performanceSnapshotState.js';

function createTransaction({ visits, removedVisits, milestones }) {
  const updates = [];
  const state = {};
  const transaction = {
    ...snapshotInvalidationMock(state),
    $queryRawUnsafe: async () => [],
    vehicle: {
      findMany: async () => [{ id: 'vehicle', physicalVehicleId: 'physical', saleDate: null }],
    },
    workshopVisit: {
      findMany: async ({ where }) => (where.id?.notIn ? visits : removedVisits),
    },
    freeServiceMilestone: {
      findMany: async () => milestones,
      updateMany: async ({ where, data }) => {
        updates.push({ id: where.id, data });
        return { count: 1 };
      },
      createMany: async () => ({ count: 0 }),
    },
  };
  return { transaction, updates, state };
}

test('missing sale date still clears exact and unambiguous references to removed visits', async () => {
  const removedVisit = { id: 'removed', physicalVehicleId: 'physical', repairOrderNo: 'RO 1' };
  const { transaction, updates, state } = createTransaction({
    visits: [],
    removedVisits: [removedVisit],
    milestones: [
      { id: 'exact', vehicleId: 'vehicle', status: 'completed', completedByWorkshopVisitId: 'removed' },
      { id: 'legacy', vehicleId: 'vehicle', status: 'completed', completedByWorkshopVisitId: null, completedByRepairOrderNo: 'ro  1' },
    ],
  });

  const result = await reconcilePhysicalVehicleMilestones(transaction, ['physical'], {
    excludeVisitIds: ['removed'],
    createMissing: false,
  });

  assert.equal(result.changed, true);
  assert.equal(updates.length, 2);
  assert.ok(updates.every(({ data }) => data.status === 'pending'
    && data.completedAt === null
    && data.completedByRepairOrderNo === null
    && data.completedByWorkshopVisitId === null));
  assert.equal(state.revisions.global, isPerformanceAggregateMaintenanceEnabled() ? 1 : 0);
});

test('missing sale date does not clear an ambiguous legacy repair-order reference', async () => {
  const retainedVisit = { id: 'retained', physicalVehicleId: 'physical', repairOrderNo: 'RO 1' };
  const removedVisit = { id: 'removed', physicalVehicleId: 'physical', repairOrderNo: 'RO 1' };
  const { transaction, updates } = createTransaction({
    visits: [retainedVisit],
    removedVisits: [removedVisit],
    milestones: [{
      id: 'legacy',
      vehicleId: 'vehicle',
      status: 'completed',
      completedByWorkshopVisitId: null,
      completedByRepairOrderNo: 'ro 1',
    }],
  });

  await reconcilePhysicalVehicleMilestones(transaction, ['physical'], {
    excludeVisitIds: ['removed'],
    createMissing: false,
  });

  assert.deepEqual(updates, []);
});
