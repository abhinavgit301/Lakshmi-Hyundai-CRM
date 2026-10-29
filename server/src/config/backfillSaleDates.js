import { prisma } from './prisma.js';
import { normalizeSaleDate } from '../utils/serviceCalendar.js';

// Copies the sale date from imported repair-order details onto vehicles that do not have one yet.
// Idempotent and never overwrites an existing sale date. Vehicles with no valid sale date in any
// repair order are left null so they surface as data issues instead of being given a made-up date.
export async function backfillVehicleSaleDates(db = prisma) {
  const vehicles = await db.vehicle.findMany({
    where: { saleDate: null, workshopVisits: { some: {} } },
    select: { id: true, workshopVisits: { select: { importedDetails: true } } },
  });

  let updated = 0;
  for (const vehicle of vehicles) {
    const saleDate = vehicle.workshopVisits
      .map((visit) => normalizeSaleDate(visit.importedDetails?.saleDate))
      .find(Boolean);
    if (!saleDate) continue;
    await db.vehicle.update({ where: { id: vehicle.id }, data: { saleDate } });
    updated += 1;
  }
  return updated;
}
