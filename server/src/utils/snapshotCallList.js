import { prisma } from '../config/prisma.js';
import { addCanonicalMasterCallListEntry } from './masterCallList.js';
import { workshopVisitVisibilityWhere } from './creAccess.js';
import { freeServiceCustomerIdsForMonth, getServiceLifecycle } from './serviceCalendar.js';
import { classifyServiceDue, getYearlyDueDate } from './serviceDue.js';
import { latestWorkshopVisitOrderBy } from './workshopVisitOrdering.js';

const PAGE_SIZE = 500;

export function isSnapshotSlimCallListEnabled(env = process.env) {
  return ['true', '1'].includes(String(env.PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED || '').trim().toLowerCase());
}

export function isSnapshotStreamedCallListEnabled(env = process.env) {
  return isSnapshotSlimCallListEnabled(env)
    && ['true', '1'].includes(String(env.PERFORMANCE_SNAPSHOT_STREAMED_CALL_LIST_ENABLED || '').trim().toLowerCase());
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

async function loadCanonicalRecords(where, db, snapshotTrace) {
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

  return { records: [...canonical.values()], rows };
}

async function loadVisitBatch(db, user, ids) {
  return db.workshopVisit.findMany({
    where: { physicalVehicleId: { in: ids }, ...workshopVisitVisibilityWhere(user) },
    orderBy: latestWorkshopVisitOrderBy,
    select: { id: true, physicalVehicleId: true, visitDate: true, importedDetails: true },
  });
}

export async function loadSnapshotCallListRecords(where, now, user, {
  snapshotTrace, db = prisma, resolveLifecycle = getServiceLifecycle,
} = {}) {
  const { records, rows } = await loadCanonicalRecords(where, db, snapshotTrace);
  const ids = [...new Set(records.map((record) => record.physicalVehicleId).filter(Boolean))];
  const visitsByVehicle = new Map();
  let visitsLoaded = 0;
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const visits = await loadVisitBatch(db, user, ids.slice(offset, offset + PAGE_SIZE));
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
    const { referenceDate } = resolveLifecycle(record, now);
    record.dueDate = referenceDate ? getYearlyDueDate([{ visitDate: referenceDate }]) : null;
  }
  if (snapshotTrace) snapshotTrace.emit('call_list_loaded', {
    rows, canonicalRecords: records.length, physicalVehicles: ids.length, visits: visitsLoaded,
  });
  return records;
}

export async function summarizeSnapshotCallList(where, now, user, {
  year, month, includeFreeService, asOf = now, db = prisma, snapshotTrace,
}) {
  const { records, rows } = await loadCanonicalRecords(where, db, snapshotTrace);
  const byPhysical = new Map();
  for (const record of records) {
    if (!record.physicalVehicleId) continue;
    if (!byPhysical.has(record.physicalVehicleId)) byPhysical.set(record.physicalVehicleId, []);
    byPhysical.get(record.physicalVehicleId).push(record);
  }
  const ids = [...byPhysical.keys()];
  const freeCustomers = new Set();
  const workloadCustomers = new Set();
  const oneYearCustomers = new Set();
  const sixMonthCustomers = new Set();
  let oneYear = 0;
  let sixMonth = 0;
  let overdue = 0;
  let visitsLoaded = 0;
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const batchIds = ids.slice(offset, offset + PAGE_SIZE);
    const visits = await loadVisitBatch(db, user, batchIds);
    visitsLoaded += visits.length;
    const histories = new Map(batchIds.map((id) => [id, []]));
    for (const visit of visits) histories.get(visit.physicalVehicleId).push(visit);
    const batchRecords = [];
    for (const id of batchIds) {
      for (const record of byPhysical.get(id)) {
        record.workshopVisits = histories.get(id);
        batchRecords.push(record);
      }
    }
    const resolveLifecycle = createSnapshotLifecycleResolver();
    for (const record of batchRecords) {
      const { referenceDate } = resolveLifecycle(record, asOf);
      const category = classifyServiceDue(referenceDate, asOf);
      if (category === '1y') { oneYear += 1; oneYearCustomers.add(record.customerId); }
      if (category === '6m') { sixMonth += 1; sixMonthCustomers.add(record.customerId); }
      if (category && record.customerId) workloadCustomers.add(record.customerId);
    }
    if (includeFreeService) {
      for (const id of freeServiceCustomerIdsForMonth(batchRecords, year, month, asOf, resolveLifecycle)) {
        freeCustomers.add(id);
        workloadCustomers.add(id);
      }
    }
    for (const record of batchRecords) {
      const { referenceDate } = resolveLifecycle(record, now);
      if (referenceDate && getYearlyDueDate([{ visitDate: referenceDate }]) < now) overdue += 1;
    }
    for (const record of batchRecords) delete record.workshopVisits;
  }
  if (snapshotTrace) snapshotTrace.emit('call_list_loaded', {
    rows, canonicalRecords: records.length, physicalVehicles: ids.length, visits: visitsLoaded,
  });
  return {
    oneYear, sixMonth, freeService: includeFreeService ? freeCustomers.size : null,
    assignedWorkload: workloadCustomers.size, dueServicesCount: overdue,
    oneYearCustomers: oneYearCustomers.size, sixMonthCustomers: sixMonthCustomers.size,
  };
}

export async function summarizeDashboardCallList(where, now, user, options) {
  const { oneYearCustomers, sixMonthCustomers, ...summary } = await summarizeSnapshotCallList(where, now, user, options);
  return summary;
}
