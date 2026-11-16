import { prisma } from '../config/prisma.js';
import { addCanonicalMasterCallListEntry } from './masterCallList.js';
import { workshopVisitVisibilityWhere } from './creAccess.js';
import { getServiceLifecycle } from './serviceCalendar.js';
import { getYearlyDueDate } from './serviceDue.js';
import { latestWorkshopVisitOrderBy } from './workshopVisitOrdering.js';

const PAGE_SIZE = 500;

export function isSnapshotSlimCallListEnabled(env = process.env) {
  return ['true', '1'].includes(String(env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED || '').trim().toLowerCase());
}

export function createSnapshotLifecycleResolver(calculate = getServiceLifecycle) {
  const cached = new Map();
  return (record, asOf) => {
    const previous = cached.get(record);
    if (previous && previous.time === asOf.getTime()) return previous.lifecycle;
    const lifecycle = calculate(record, asOf);
    cached.set(record, { time: asOf.getTime(), lifecycle });
    return lifecycle;
  };
}

export async function loadSnapshotCallListRecords(where, now, user, { snapshotTrace, db = prisma } = {}) {
  const canonical = new Map();
  let cursor = null;
  let pages = 0;
  let rows = 0;
  while (true) {
    const pageWhere = cursor ? {
      AND: [where, { OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] }],
    } : where;
    const page = await db.masterCallList.findMany({
      where: pageWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE,
      select: {
        id: true, createdAt: true, ccmId: true, vin: true, ownerUserId: true,
        vehicle: { select: { customerId: true, saleDate: true, physicalVehicleId: true } },
      },
    });
    pages += 1;
    rows += page.length;
    if (snapshotTrace && (pages === 1 || pages % 10 === 0 || page.length < PAGE_SIZE)) {
      snapshotTrace.emit('call_list_progress', { pages, rows });
    }
    for (const row of page) {
      addCanonicalMasterCallListEntry(canonical, {
        id: row.id,
        createdAt: row.createdAt,
        ccmId: row.ccmId,
        vin: row.vin,
        assigneeId: row.ownerUserId,
        customerId: row.vehicle?.customerId || null,
        saleDate: row.vehicle?.saleDate || null,
        physicalVehicleId: row.vehicle?.physicalVehicleId || null,
      });
    }
    if (page.length < PAGE_SIZE) break;
    const last = page.at(-1);
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  const records = [...canonical.values()];
  const ids = [...new Set(records.map((record) => record.physicalVehicleId).filter(Boolean))];
  const visitsByVehicle = new Map();
  let visitsLoaded = 0;
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const visits = await db.workshopVisit.findMany({
      where: { physicalVehicleId: { in: ids.slice(offset, offset + PAGE_SIZE) }, ...workshopVisitVisibilityWhere(user) },
      orderBy: latestWorkshopVisitOrderBy,
      select: { id: true, physicalVehicleId: true, visitDate: true, importedDetails: true },
    });
    visitsLoaded += visits.length;
    for (const visit of visits) {
      let history = visitsByVehicle.get(visit.physicalVehicleId);
      if (!history) {
        history = [];
        visitsByVehicle.set(visit.physicalVehicleId, history);
      }
      history.push(visit);
    }
  }
  for (const record of records) {
    record.workshopVisits = visitsByVehicle.get(record.physicalVehicleId) || [];
    const { referenceDate } = getServiceLifecycle(record, now);
    record.dueDate = referenceDate ? getYearlyDueDate([{ visitDate: referenceDate }]) : null;
  }
  if (snapshotTrace) snapshotTrace.emit('call_list_loaded', {
    rows, canonicalRecords: records.length, physicalVehicles: ids.length, visits: visitsLoaded,
  });
  return records;
}
