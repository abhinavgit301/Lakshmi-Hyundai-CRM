import { freeServiceVisitsByMilestone, normalizeSaleDate } from './serviceCalendar.js';
import { invalidateSnapshotSourceWrite } from './performanceSnapshotState.js';
import { signalSnapshotRefresh } from './performanceRefreshSignal.js';

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function planFreeServiceReconciliation(vehicle, now = new Date()) {
  const visits = vehicle.physicalVehicle.workshopVisits;
  const storedDate = normalizeSaleDate(vehicle.saleDate, now);
  if (vehicle.saleDate != null && !storedDate) {
    return { error: 'invalid or future stored sale date', updates: [] };
  }
  const importedDates = new Map();
  for (const visit of visits) {
    const date = normalizeSaleDate(visit.importedDetails?.saleDate, now);
    if (date) importedDates.set(dateKey(date), date);
  }
  const saleDate = storedDate || (importedDates.size === 1 ? [...importedDates.values()][0] : null);
  if (!saleDate) return { error: 'missing or ambiguous sale date', updates: [] };
  const completed = freeServiceVisitsByMilestone(saleDate, visits, now);
  const updates = [];
  for (const row of vehicle.freeServiceMilestones) {
    if (![1, 2, 3].includes(row.milestone) || !['pending', 'completed'].includes(row.status)) {
      return { error: 'unsupported milestone or status', updates: [] };
    }
    const visit = completed.get(row.milestone);
    const data = visit ? {
      status: 'completed',
      completedAt: visit.visitDate,
      completedByRepairOrderNo: visit.repairOrderNo,
      completedByWorkshopVisitId: visit.id,
    } : {
      status: 'pending',
      completedAt: null,
      completedByRepairOrderNo: null,
      completedByWorkshopVisitId: null,
    };
    if (row.status !== data.status
      || (row.completedByWorkshopVisitId ?? null) !== data.completedByWorkshopVisitId
      || (row.completedByRepairOrderNo ?? null) !== data.completedByRepairOrderNo
      || (row.completedAt?.getTime() ?? null) !== (data.completedAt?.getTime() ?? null)) {
      updates.push({ id: row.id, data });
    }
  }
  return { error: null, updates };
}

// This operation is intended for a maintenance window, not a request path.
export async function reconcileFreeServiceMilestones(db, { apply = false, now = new Date() } = {}) {
  const result = await db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SET LOCAL lock_timeout = '10s'`;
    await transaction.$executeRaw`LOCK TABLE "vehicles", "workshop_visits", "free_service_milestones" IN SHARE ROW EXCLUSIVE MODE`;
    let cursor;
    let vehicleCount = 0;
    let updateCount = 0;
    const unresolved = [];
    for (;;) {
      const vehicles = await transaction.vehicle.findMany({
        where: { freeServiceMilestones: { some: {} } },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          saleDate: true,
          freeServiceMilestones: { select: {
            id: true, milestone: true, status: true, completedAt: true,
            completedByRepairOrderNo: true, completedByWorkshopVisitId: true,
          } },
          physicalVehicle: { select: { workshopVisits: { select: {
            id: true, repairOrderNo: true, visitDate: true, importedDetails: true,
          } } } },
        },
      });
      if (!vehicles.length) break;
      for (const vehicle of vehicles) {
        vehicleCount += 1;
        const plan = planFreeServiceReconciliation(vehicle, now);
        if (plan.error) {
          unresolved.push({ vehicleId: vehicle.id, reason: plan.error });
          continue;
        }
        updateCount += plan.updates.length;
        if (apply) {
          for (const update of plan.updates) {
            await transaction.freeServiceMilestone.update({ where: { id: update.id }, data: update.data });
          }
        }
      }
      cursor = vehicles[vehicles.length - 1].id;
    }
    if (apply && unresolved.length) {
      throw new Error(`Reconciliation aborted: ${unresolved.length} vehicles have missing, ambiguous or unsupported data. Run the dry run for details.`);
    }
    if (apply && updateCount) await invalidateSnapshotSourceWrite(transaction);
    return { vehicleCount, updateCount, unresolved };
  }, { timeout: 900000, maxWait: 10000 });
  if (apply && result.updateCount) signalSnapshotRefresh();
  return result;
}
