import { prisma } from '../config/prisma.js';
import { addMonths } from './serviceDue.js';
import {
  FREE_SERVICE_MILESTONES,
  freeServiceVisitsByMilestone,
  findMissedCases,
  freeServiceDueDate,
  getServiceLifecycle,
  normalizeSaleDate,
  warrantyExpiryDate,
} from './serviceCalendar.js';
import { getWorkshopTimezone } from './workshopTime.js';
import { normalizeRepairOrderNo } from './repairOrderIdentity.js';
import { workshopVisitVisibilityWhere } from './creAccess.js';
import { invalidateSnapshotSourceWrite, isPerformanceAggregateMaintenanceEnabled } from './performanceSnapshotState.js';
import { signalSnapshotRefresh } from './performanceRefreshSignal.js';
import { reconcilePhysicalVehicleMilestones } from './physicalVehicleMilestones.js';

export async function excludeIneligibleFreeServiceFollowUps(where, user, db = prisma) {
  const sourceFilter = where.source;
  if (sourceFilter && sourceFilter !== 'FREE_SERVICE'
    && !sourceFilter.in?.includes('FREE_SERVICE')) return where;

  const candidates = await db.followUp.findMany({
    where: { ...where, source: 'FREE_SERVICE' },
    select: {
      id: true,
      vehicle: { select: { physicalVehicleId: true, saleDate: true } },
      milestone: { select: { milestone: true, dueDate: true, status: true } },
    },
  });
  if (!candidates.length) return where;

  const physicalVehicleIds = [...new Set(candidates.map(({ vehicle }) => vehicle?.physicalVehicleId).filter(Boolean))];
  const visits = physicalVehicleIds.length
    ? await db.workshopVisit.findMany({
      where: {
        physicalVehicleId: { in: physicalVehicleIds },
        ...workshopVisitVisibilityWhere(user),
      },
      select: { id: true, physicalVehicleId: true, visitDate: true, importedDetails: true },
    })
    : [];
  const visitsByPhysicalVehicle = new Map();
  for (const visit of visits) {
    const records = visitsByPhysicalVehicle.get(visit.physicalVehicleId) || [];
    records.push(visit);
    visitsByPhysicalVehicle.set(visit.physicalVehicleId, records);
  }

  const ineligibleIds = candidates.filter(({ vehicle, milestone }) => {
    if (!vehicle?.physicalVehicleId) return true;
    const vehicleVisits = visitsByPhysicalVehicle.get(vehicle.physicalVehicleId) || [];
    const lifecycle = getServiceLifecycle({ saleDate: vehicle.saleDate, workshopVisits: vehicleVisits });
    if (lifecycle.phase !== 'free') return true;
    return Boolean(milestone && lifecycle.completedMilestones.includes(milestone.milestone));
  }).map(({ id }) => id);
  if (!ineligibleIds.length) return where;

  const eligibilityCondition = where.source === 'FREE_SERVICE'
    ? { id: { notIn: ineligibleIds } }
    : { OR: [{ source: { not: 'FREE_SERVICE' } }, { id: { notIn: ineligibleIds } }] };
  return { ...where, AND: [...(where.AND || []), eligibilityCondition] };
}

export function filterMilestoneCompletionByVisits(milestones, records) {
  const recordsByVehicle = new Map(records.map((record) => [record.vehicleId, record]));
  return milestones.map((milestone) => {
    const record = recordsByVehicle.get(milestone.vehicleId);
    if (record?.saleDate) {
      const visit = freeServiceVisitsByMilestone(record.saleDate, record.workshopVisits).get(milestone.milestone);
      return visit ? {
        ...milestone,
        status: 'completed',
        completedAt: visit.visitDate,
        completedByRepairOrderNo: visit.repairOrderNo,
        completedByWorkshopVisitId: visit.id,
      } : {
        ...milestone,
        status: 'pending',
        completedAt: null,
        completedByRepairOrderNo: null,
        completedByWorkshopVisitId: null,
      };
    }
    if (milestone.status !== 'completed') return milestone;
    const visits = record?.workshopVisits || [];
    const completingVisitIsVisible = milestone.completedByWorkshopVisitId
      ? visits.some((visit) => visit.id === milestone.completedByWorkshopVisitId)
      : visits.filter((visit) => normalizeRepairOrderNo(visit.repairOrderNo)
        === normalizeRepairOrderNo(milestone.completedByRepairOrderNo)).length === 1;
    return completingVisitIsVisible
      ? milestone
      : {
        ...milestone,
        status: 'pending',
        completedAt: null,
        completedByRepairOrderNo: null,
        completedByWorkshopVisitId: null,
      };
  });
}

// Creates missing milestones from the original sale date and never rebases existing milestone dates.
// A completed milestone is never reopened, so re-imports cannot reset its date or completion history.
export async function syncFreeServiceMilestones(vehicles, db = prisma) {
  const usable = vehicles.filter((vehicle) => vehicle.saleDate);
  if (!usable.length) return [];
  if (db.$transaction && db.$queryRawUnsafe) {
    const physicalVehicleIds = [...new Set(usable.map(({ physicalVehicleId }) => physicalVehicleId))];
    if (physicalVehicleIds.some((id) => !id)) {
      throw new Error('Cannot synchronize Free Service milestones without physical vehicle identities.');
    }
    const result = await db.$transaction((transaction) => reconcilePhysicalVehicleMilestones(transaction, physicalVehicleIds));
    if (result.changed && isPerformanceAggregateMaintenanceEnabled()) signalSnapshotRefresh();
    return db.freeServiceMilestone.findMany({
      where: { vehicleId: { in: usable.map(({ id }) => id) } },
      orderBy: [{ dueDate: 'asc' }],
    });
  }
  if (!isPerformanceAggregateMaintenanceEnabled()) {
    return (await syncMilestones(usable, db, { parallelUpdates: true })).milestones;
  }
  for (let offset = 0; offset < usable.length; offset += 100) {
    const batch = usable.slice(offset, offset + 100);
    const result = await db.$transaction(async (transaction) => {
      const synced = await syncMilestones(batch, transaction);
      if (synced.changed) await invalidateSnapshotSourceWrite(transaction);
      return synced;
    });
    if (result.changed) signalSnapshotRefresh();
  }
  return db.freeServiceMilestone.findMany({
    where: { vehicleId: { in: usable.map((vehicle) => vehicle.id) } },
    orderBy: [{ dueDate: 'asc' }],
  });
}

async function syncMilestones(usable, db, { parallelUpdates = false } = {}) {
  const asOf = new Date();

  const existing = await db.freeServiceMilestone.findMany({ where: { vehicleId: { in: usable.map((vehicle) => vehicle.id) } } });
  const byKey = new Map(existing.map((entry) => [`${entry.vehicleId}:${entry.milestone}`, entry]));

  const missing = [];
  const updates = [];
  for (const vehicle of usable) {
    const completingVisits = freeServiceVisitsByMilestone(vehicle.saleDate, vehicle.workshopVisits, asOf);
    for (const { milestone } of FREE_SERVICE_MILESTONES) {
      const dueDate = freeServiceDueDate(vehicle.saleDate, milestone);
      const current = byKey.get(`${vehicle.id}:${milestone}`);
      if (!current) {
        const visit = completingVisits.get(milestone);
        missing.push({
          vehicleId: vehicle.id,
          physicalVehicleId: vehicle.physicalVehicleId,
          milestone,
          dueDate,
          ...(visit ? {
            status: 'completed',
            completedAt: new Date(visit.visitDate),
            completedByRepairOrderNo: visit.repairOrderNo,
            completedByWorkshopVisitId: visit.id,
            physicalVehicleId: vehicle.physicalVehicleId,
          } : {}),
        });
        continue;
      }
      if (current.status === 'completed') continue;
      const visit = completingVisits.get(milestone);
      if (visit) {
        updates.push({
          where: { id: current.id, status: current.status },
          data: {
            status: 'completed',
            completedAt: new Date(visit.visitDate),
            completedByRepairOrderNo: visit.repairOrderNo,
            completedByWorkshopVisitId: visit.id,
            physicalVehicleId: vehicle.physicalVehicleId,
          },
        });
      }
    }
  }

  const created = missing.length ? await db.freeServiceMilestone.createMany({ data: missing, skipDuplicates: true }) : { count: 0 };
  let updated = 0;
  if (parallelUpdates) {
    for (let offset = 0; offset < updates.length; offset += 20) {
      const results = await Promise.all(updates.slice(offset, offset + 20).map((update) => db.freeServiceMilestone.updateMany(update)));
      updated += results.reduce((sum, result) => sum + result.count, 0);
    }
  } else {
    for (const update of updates) updated += (await db.freeServiceMilestone.updateMany(update)).count;
  }
  const milestones = await db.freeServiceMilestone.findMany({
    where: { vehicleId: { in: usable.map((vehicle) => vehicle.id) } },
    orderBy: [{ dueDate: 'asc' }],
  });
  return { milestones, changed: created.count > 0 || updated > 0 };
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
  db = prisma,
}) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 1);
  // Sale-date range that can expire inside the month, padded a day either side for month-end clamping.
  const saleFrom = new Date(addMonths(monthStart, -36).getTime() - 86400000);
  const saleTo = new Date(addMonths(monthEnd, -36).getTime() + 86400000);

  const vehicles = await db.vehicle.findMany({
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

  const calls = await db.callLog.findMany({
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
