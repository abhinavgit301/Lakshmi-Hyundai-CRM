import { prisma } from './prisma.js';
import { normalizeSaleDate } from '../utils/serviceCalendar.js';
import { invalidateSnapshotSourceWrite } from '../utils/performanceSnapshotState.js';
import { signalSnapshotRefresh } from '../utils/performanceRefreshSignal.js';
import { lockPhysicalVehicles, reconcilePhysicalVehicleMilestones } from '../utils/physicalVehicleMilestones.js';

// Copies the sale date from imported repair-order details onto vehicles that do not have one yet.
// Idempotent and never overwrites an existing sale date. Vehicles with no valid sale date in any
// repair order are left null so they surface as data issues instead of being given a made-up date.
export async function backfillVehicleSaleDates(db = prisma) {
  const vehicles = await db.vehicle.findMany({
    where: { saleDate: null, workshopVisits: { some: {} } },
    select: { id: true, physicalVehicleId: true, workshopVisits: { select: { importedDetails: true } } },
  });

  let updated = 0;
  for (const vehicle of vehicles) {
    const saleDate = vehicle.workshopVisits
      .map((visit) => normalizeSaleDate(visit.importedDetails?.saleDate))
      .find(Boolean);
    if (!saleDate) continue;
    const changed = await db.$transaction(async (transaction) => {
      await lockPhysicalVehicles(transaction, [vehicle.physicalVehicleId]);
      const result = await transaction.vehicle.updateMany({
        where: { id: vehicle.id, saleDate: null },
        data: { saleDate },
      });
      if (result.count) {
        const current = await transaction.vehicle.findUniqueOrThrow({ where: { id: vehicle.id }, select: { ccmId: true } });
        await reconcilePhysicalVehicleMilestones(transaction, [vehicle.physicalVehicleId]);
        await invalidateSnapshotSourceWrite(transaction, { ccmIds: [current.ccmId] });
      }
      return result.count;
    });
    if (changed) {
      signalSnapshotRefresh();
      updated += changed;
    }
  }
  return updated;
}
