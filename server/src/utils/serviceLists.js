import { prisma } from '../config/prisma.js';
import { addMonths } from './serviceDue.js';
import {
  FREE_SERVICE_MILESTONES,
  findCompletingVisit,
  findMissedCases,
  freeServiceDueDate,
  normalizeSaleDate,
  warrantyExpiryDate,
} from './serviceCalendar.js';
import { getWorkshopTimezone } from './workshopTime.js';

// Creates any missing milestone rows for vehicles with a valid sale date, keeps pending due dates
// aligned with the sale date, and marks a milestone completed only when a free-service repair order
// reliably establishes it. A completed milestone is never reopened, so re-imports cannot reset it.
export async function syncFreeServiceMilestones(vehicles, db = prisma) {
  const usable = vehicles.filter((vehicle) => vehicle.saleDate);
  if (!usable.length) return [];

  const existing = await db.freeServiceMilestone.findMany({ where: { vehicleId: { in: usable.map((vehicle) => vehicle.id) } } });
  const byKey = new Map(existing.map((entry) => [`${entry.vehicleId}:${entry.milestone}`, entry]));

  const missing = [];
  const updates = [];
  for (const vehicle of usable) {
    for (const { milestone } of FREE_SERVICE_MILESTONES) {
      const dueDate = freeServiceDueDate(vehicle.saleDate, milestone);
      const current = byKey.get(`${vehicle.id}:${milestone}`);
      if (!current) {
        const visit = findCompletingVisit(dueDate, vehicle.workshopVisits);
        missing.push({
          vehicleId: vehicle.id,
          milestone,
          dueDate,
          ...(visit ? { status: 'completed', completedAt: new Date(visit.visitDate), completedByRepairOrderNo: visit.repairOrderNo } : {}),
        });
        continue;
      }
      if (current.status === 'completed') continue;
      const visit = findCompletingVisit(dueDate, vehicle.workshopVisits);
      const dueChanged = current.dueDate.getTime() !== dueDate.getTime();
      if (visit || dueChanged) {
        updates.push(db.freeServiceMilestone.update({
          where: { id: current.id },
          data: {
            dueDate,
            ...(visit ? { status: 'completed', completedAt: new Date(visit.visitDate), completedByRepairOrderNo: visit.repairOrderNo } : {}),
          },
        }));
      }
    }
  }

  if (missing.length) await db.freeServiceMilestone.createMany({ data: missing, skipDuplicates: true });
  if (updates.length) await Promise.all(updates);
  return db.freeServiceMilestone.findMany({
    where: { vehicleId: { in: usable.map((vehicle) => vehicle.id) } },
    orderBy: [{ dueDate: 'asc' }],
  });
}

// Missed-warranty cases whose warranty expired during the given calendar month: one per vehicle, with no
// answered warranty call before the warranty lapsed. `scope` is a MasterCallList filter for the CRE/team.
export async function findMissedWarrantyCases({
  scope,
  vehicleScope = {},
  callScope = {},
  year,
  month,
  now = new Date(),
  timeZone = getWorkshopTimezone(),
}) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 1);
  // Sale-date range that can expire inside the month, padded a day either side for month-end clamping.
  const saleFrom = new Date(addMonths(monthStart, -36).getTime() - 86400000);
  const saleTo = new Date(addMonths(monthEnd, -36).getTime() + 86400000);

  const vehicles = await prisma.vehicle.findMany({
    where: {
      ...vehicleScope,
      saleDate: { gte: saleFrom, lt: saleTo },
      masterCallListEntries: { some: scope },
    },
    select: { id: true, vin: true, registrationNumber: true, saleDate: true, customerId: true, customer: { select: { fullName: true } } },
  });

  const dated = vehicles
    .map((vehicle) => ({ vehicle, saleDate: normalizeSaleDate(vehicle.saleDate, now) }))
    .filter((entry) => entry.saleDate)
    .map((entry) => ({ ...entry, expiryDate: warrantyExpiryDate(entry.saleDate) }))
    .filter((entry) => entry.expiryDate >= monthStart && entry.expiryDate < monthEnd);
  if (!dated.length) return [];

  const calls = await prisma.callLog.findMany({
    where: { ...callScope, vehicleId: { in: dated.map((entry) => entry.vehicle.id) }, callSource: 'WARRANTY' },
    select: { vehicleId: true, outcome: true, createdAt: true, callSource: true },
  });
  const callsByVehicle = new Map();
  for (const call of calls) callsByVehicle.set(call.vehicleId, [...(callsByVehicle.get(call.vehicleId) || []), call]);

  return findMissedCases(
    dated.map((entry) => ({ ...entry, vehicleId: entry.vehicle.id, calls: callsByVehicle.get(entry.vehicle.id) || [] })),
    { now, timeZone },
  ).map((entry) => ({
    vehicleId: entry.vehicle.id,
    vin: entry.vehicle.vin,
    registrationNumber: entry.vehicle.registrationNumber,
    customerName: entry.vehicle.customer?.fullName || null,
    saleDate: entry.saleDate,
    expiryDate: entry.expiryDate,
  }));
}
