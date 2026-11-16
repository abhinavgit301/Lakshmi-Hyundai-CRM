import {
  freeServiceDueDate,
  freeServiceVisitsByMilestone,
  FREE_SERVICE_MILESTONES,
  normalizeSaleDate,
  resolveSaleDate,
} from './serviceCalendar.js';
import { normalizeRepairOrderNo } from './repairOrderIdentity.js';
import { invalidateSnapshotSourceWrite } from './performanceSnapshotState.js';
import { planFreeServiceReconciliation } from './reconcileFreeServiceMilestones.js';

export async function lockPhysicalVehicles(transaction, physicalVehicleIds) {
  for (const id of [...new Set(physicalVehicleIds.filter(Boolean))].sort()) {
    await transaction.$queryRawUnsafe(
      'SELECT "id" FROM "physical_vehicles" WHERE "id" = $1 FOR UPDATE',
      id,
    );
  }
}

export async function reconcilePhysicalVehicleMilestones(transaction, physicalVehicleIds, {
  excludeVisitIds = [],
  saleDateOverrides = new Map(),
  createMissing = true,
  now = new Date(),
} = {}) {
  const ids = [...new Set(physicalVehicleIds.filter(Boolean))].sort();
  if (!ids.length) return { changed: false, vehicleCount: 0 };
  await lockPhysicalVehicles(transaction, ids);
  const [vehicles, visits] = await Promise.all([
    transaction.vehicle.findMany({
      where: { physicalVehicleId: { in: ids } },
      select: { id: true, physicalVehicleId: true, saleDate: true },
      orderBy: { id: 'asc' },
    }),
    transaction.workshopVisit.findMany({
      where: {
        physicalVehicleId: { in: ids },
        ...(excludeVisitIds.length ? { id: { notIn: excludeVisitIds } } : {}),
      },
      select: { id: true, physicalVehicleId: true, repairOrderNo: true, visitDate: true, importedDetails: true },
      orderBy: [{ visitDate: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const removedVisits = excludeVisitIds.length
    ? await transaction.workshopVisit.findMany({
      where: { id: { in: excludeVisitIds }, physicalVehicleId: { in: ids } },
      select: { id: true, physicalVehicleId: true, repairOrderNo: true, visitDate: true, importedDetails: true },
    })
    : [];
  if (!vehicles.length) return { changed: false, vehicleCount: 0 };
  const vehicleIds = vehicles.map(({ id }) => id);
  const rows = await transaction.freeServiceMilestone.findMany({
    where: { vehicleId: { in: vehicleIds } },
  });
  const visitsByPhysical = new Map(ids.map((id) => [id, []]));
  for (const visit of visits) visitsByPhysical.get(visit.physicalVehicleId).push(visit);
  const allVisitsByPhysical = new Map(ids.map((id) => [id, [...visitsByPhysical.get(id)]]));
  for (const visit of removedVisits) allVisitsByPhysical.get(visit.physicalVehicleId).push(visit);
  const milestonesByVehicle = new Map(vehicles.map(({ id }) => [id, []]));
  for (const row of rows) milestonesByVehicle.get(row.vehicleId)?.push(row);

  const updates = [];
  const creates = [];
  for (const vehicle of vehicles) {
    const vehicleVisits = visitsByPhysical.get(vehicle.physicalVehicleId) || [];
    const allVehicleVisits = allVisitsByPhysical.get(vehicle.physicalVehicleId) || vehicleVisits;
    const physicalVehicle = { workshopVisits: vehicleVisits };
    const storedSaleDate = saleDateOverrides.has(vehicle.id) ? saleDateOverrides.get(vehicle.id) : vehicle.saleDate;
    const saleDate = storedSaleDate != null && !normalizeSaleDate(storedSaleDate, now)
      ? null
      : resolveSaleDate({
        saleDate: storedSaleDate,
        workshopVisits: physicalVehicle.workshopVisits,
      }, now);
    if (!saleDate) {
      const removedIds = new Set(removedVisits
        .filter((visit) => visit.physicalVehicleId === vehicle.physicalVehicleId)
        .map(({ id }) => id));
      const removedByRo = new Map();
      for (const visit of allVehicleVisits) {
        const key = normalizeRepairOrderNo(visit.repairOrderNo);
        if (!key) continue;
        const matches = removedByRo.get(key) || [];
        matches.push(visit.id);
        removedByRo.set(key, matches);
      }
      const allVisitsById = new Map(allVehicleVisits.map((visit) => [visit.id, visit]));
      for (const row of milestonesByVehicle.get(vehicle.id)) {
        const removedById = row.completedByWorkshopVisitId && removedIds.has(row.completedByWorkshopVisitId);
        const legacyMatches = row.completedByWorkshopVisitId == null && row.completedByRepairOrderNo
          ? removedByRo.get(normalizeRepairOrderNo(row.completedByRepairOrderNo)) || []
          : [];
        const removedLegacyReference = legacyMatches.length === 1
          && allVisitsById.has(legacyMatches[0])
          && removedIds.has(legacyMatches[0]);
        if (removedById || removedLegacyReference) {
          updates.push({
            id: row.id,
            data: {
              status: 'pending',
              completedAt: null,
              completedByRepairOrderNo: null,
              completedByWorkshopVisitId: null,
            },
          });
        }
      }
      if (milestonesByVehicle.get(vehicle.id).length && !removedIds.size) {
        throw new Error(`Cannot reconcile Free Service milestones for vehicle ${vehicle.id}: sale date is missing or invalid.`);
      }
      continue;
    }
    const plan = planFreeServiceReconciliation({
      ...vehicle,
      saleDate,
      physicalVehicle,
      freeServiceMilestones: milestonesByVehicle.get(vehicle.id),
    }, now);
    if (plan.error) throw new Error(`Cannot reconcile Free Service milestones for vehicle ${vehicle.id}: ${plan.error}.`);
    updates.push(...plan.updates);
    const present = new Set(milestonesByVehicle.get(vehicle.id).map(({ milestone }) => milestone));
    const completions = freeServiceVisitsByMilestone(saleDate, physicalVehicle.workshopVisits, now);
    for (const { milestone } of createMissing ? FREE_SERVICE_MILESTONES : []) {
      if (present.has(milestone)) continue;
      const completed = completions.get(milestone);
      creates.push({
        vehicleId: vehicle.id,
        physicalVehicleId: vehicle.physicalVehicleId,
        milestone,
        dueDate: freeServiceDueDate(saleDate, milestone),
        ...(completed ? {
          status: 'completed',
          completedAt: completed.visitDate,
          completedByRepairOrderNo: completed.repairOrderNo,
          completedByWorkshopVisitId: completed.id,
        } : {}),
      });
    }
  }
  let changed = false;
  for (const update of updates) {
    const result = await transaction.freeServiceMilestone.updateMany({
      where: { id: update.id },
      data: update.data,
    });
    changed ||= result.count > 0;
  }
  if (creates.length) {
    const result = await transaction.freeServiceMilestone.createMany({ data: creates, skipDuplicates: true });
    changed ||= result.count > 0;
  }
  if (changed) {
    await invalidateSnapshotSourceWrite(transaction);
  }
  return { changed, vehicleCount: vehicles.length };
}
