import { prisma } from '../config/prisma.js';
import { consolidateMasterCallListEntries } from '../utils/masterCallList.js';
import { classifyServiceDue, getLatestServiceDate, getYearlyDueDate } from '../utils/serviceDue.js';

const OUTCOMES = ['CONTACTED', 'CALLBACK', 'NOT_INTERESTED', 'WRONG_NUMBER', 'APPOINTMENT_SET', 'FOLLOW_UP_LATER', 'NO_RESPONSE', 'OTHER'];

function percent(part, whole) {
  return whole ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

// The nested latest-visit load is not chunked by Prisma, so its IN list grows with the page size.
const REPORT_MASTER_LIST_PAGE_SIZE = Math.min(
  Math.max(Number.parseInt(process.env.REPORT_MASTER_LIST_PAGE_SIZE, 10) || 10000, 1),
  20000,
);

// Short-lived response cache (Admin/GM only route, identical data for both roles).
const parsedCacheTtl = Number.parseInt(process.env.REPORT_CACHE_TTL_SECONDS, 10);
const REPORT_CACHE_TTL_MS = (Number.isFinite(parsedCacheTtl) ? Math.max(parsedCacheTtl, 0) : 60) * 1000;
const REPORT_CACHE_MAX_ENTRIES = 100;
const reportCache = new Map();
const reportInFlight = new Map();

function rememberReport(key, data) {
  if (reportCache.size >= REPORT_CACHE_MAX_ENTRIES) reportCache.delete(reportCache.keys().next().value);
  reportCache.set(key, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
}

export function clearWorkshopPerformanceCache() {
  reportCache.clear();
  reportInFlight.clear();
}

async function loadMasterCallListEntriesPaged(database, ccmIds, now) {
  const entries = [];
  let cursor;
  for (;;) {
    const page = await database.masterCallList.findMany({
      where: { ccmId: { in: ccmIds } },
      orderBy: { id: 'asc' },
      take: REPORT_MASTER_LIST_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        ccmId: true,
        vin: true,
        ownerUserId: true,
        createdAt: true,
        vehicle: {
          select: {
            physicalVehicle: {
              select: {
                workshopVisits: {
                  where: { visitDate: { lte: now } },
                  orderBy: { visitDate: 'desc' },
                  take: 1,
                  select: { visitDate: true },
                },
              },
            },
          },
        },
      },
    });
    entries.push(...page);
    if (page.length < REPORT_MASTER_LIST_PAGE_SIZE) return entries;
    cursor = page[page.length - 1].id;
  }
}

export async function queryWorkshopReportsData({
  year,
  month,
  tzOffset = 0,
  ccmId = '',
  creId = '',
  now = new Date(),
}, database = prisma) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100 || !Number.isFinite(tzOffset)) {
    return null;
  }

  // Month boundaries in the viewer's local time.
  const monthStart = new Date(Date.UTC(year, month - 1, 1) + tzOffset * 60000);
  const monthEnd = new Date(Date.UTC(year, month, 1) + tzOffset * 60000);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const [users, archivedUsers] = await Promise.all([
    database.user.findMany({
    where: { role: { in: ['CCM', 'CRE'] }, ccmId: { not: null } },
    select: { id: true, name: true, role: true, ccmId: true },
    orderBy: { name: 'asc' },
    }),
    database.deletedUserIdentity.findMany({
      where: { role: 'CRE', ccmId: { not: null } },
      select: { id: true, name: true, role: true, ccmId: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const reportUsers = [
    ...users,
    ...archivedUsers.map((user) => ({ ...user, archived: true })),
  ];

  let scopeUsers = reportUsers;
  let scope = { type: 'all', id: null, name: 'All teams' };
  if (creId) {
    const cre = reportUsers.find((user) => user.id === creId && user.role === 'CRE' && (!ccmId || user.ccmId === ccmId));
    if (!cre) return { error: ccmId ? 'CRE is not assigned to the selected CCM.' : 'CRE not found.' };
    scopeUsers = [cre];
    scope = { type: 'cre', id: cre.id, name: cre.name };
  } else if (ccmId) {
    scopeUsers = reportUsers.filter((user) => user.ccmId === ccmId);
    if (!scopeUsers.length) return { error: 'Team not found.' };
    const ccm = scopeUsers.find((user) => user.role === 'CCM');
    scope = { type: 'ccm', id: ccmId, name: ccm?.name || 'Team' };
  }

  const userIds = scopeUsers.map((user) => user.id);
  const [calls, appointments, assigned, masterCallListEntries] = await Promise.all([
    database.callLog.findMany({
      where: {
        OR: [{ createdById: { in: userIds } }, { createdByIdSnapshot: { in: userIds } }],
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      select: { createdById: true, createdByIdSnapshot: true, customerId: true, outcome: true, createdAt: true },
    }),
    database.appointment.findMany({
      where: {
        OR: [{ createdById: { in: userIds } }, { createdByIdSnapshot: { in: userIds } }],
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      select: { createdById: true, createdByIdSnapshot: true, createdAt: true },
    }),
    database.masterCallList.groupBy({
      by: ['ownerUserId'],
      where: { ownerUserId: { in: userIds } },
      _count: { _all: true },
    }),
    loadMasterCallListEntriesPaged(database, [...new Set(scopeUsers.map((user) => user.ccmId))], now),
  ]);

  const dayKey = (date) => new Date(date.getTime() - tzOffset * 60000).toISOString().slice(0, 10);
  const daily = Array.from({ length: daysInMonth }, (_, index) => ({
    date: `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
    calls: 0,
    appointments: 0,
  }));
  const dailyByDate = new Map(daily.map((entry) => [entry.date, entry]));
  calls.forEach((call) => { const entry = dailyByDate.get(dayKey(call.createdAt)); if (entry) entry.calls += 1; });
  appointments.forEach((appointment) => { const entry = dailyByDate.get(dayKey(appointment.createdAt)); if (entry) entry.appointments += 1; });

  const outcomeCounts = new Map(OUTCOMES.map((outcome) => [outcome, 0]));
  calls.forEach((call) => outcomeCounts.set(call.outcome, (outcomeCounts.get(call.outcome) || 0) + 1));

  const assignedByUser = new Map(assigned.map((row) => [row.ownerUserId, row._count._all]));
  const reportCreIds = new Set(scopeUsers.filter((user) => user.role === 'CRE').map((user) => user.id));
  const dueCustomersByUser = new Map();
  const canonicalMasterCallListEntries = consolidateMasterCallListEntries(
    masterCallListEntries.map((entry) => ({ ...entry, assigneeId: entry.ownerUserId })),
  );
  // Same rule as the CRE performance "Due services" card: the yearly due date (latest service + 12
  // months) has passed. Counted across the whole Master Call List in scope, including unassigned records.
  let dueServices = 0;
  for (const entry of canonicalMasterCallListEntries) {
    const isScopedCre = reportCreIds.has(entry.ownerUserId);
    if (scope.type === 'cre' && !isScopedCre) continue;
    const visits = entry.vehicle?.physicalVehicle?.workshopVisits || [];
    const yearlyDueDate = getYearlyDueDate(visits);
    if (yearlyDueDate && yearlyDueDate < now) dueServices += 1;
    if (isScopedCre && classifyServiceDue(getLatestServiceDate(visits, now), now)) {
      dueCustomersByUser.set(entry.ownerUserId, (dueCustomersByUser.get(entry.ownerUserId) || 0) + 1);
    }
  }

  function summarize(members) {
    const ids = new Set(members.map((member) => member.id));
    const memberCalls = calls.filter((call) => ids.has(call.createdById || call.createdByIdSnapshot));
    const reached = new Set(memberCalls.map((call) => call.customerId)).size;
    const assignedCount = members.reduce((sum, member) => sum + (assignedByUser.get(member.id) || 0), 0);
    const dueCustomers = members.reduce((sum, member) => sum + (dueCustomersByUser.get(member.id) || 0), 0);
    return {
      calls: memberCalls.length,
      customersReached: reached,
      appointmentsSet: memberCalls.filter((call) => call.outcome === 'APPOINTMENT_SET').length,
      appointmentsBooked: appointments.filter((appointment) => ids.has(appointment.createdById || appointment.createdByIdSnapshot)).length,
      assignedRecords: assignedCount,
      dueCustomers,
      reachPercent: percent(reached, assignedCount),
    };
  }

  const totals = summarize(scopeUsers);
  totals.conversionPercent = percent(totals.appointmentsBooked, totals.calls);
  totals.dueServices = dueServices;

  let breakdown;
  if (scope.type === 'all') {
    const teamIds = [...new Set(scopeUsers.map((user) => user.ccmId))];
    breakdown = teamIds.map((id) => {
      const members = scopeUsers.filter((user) => user.ccmId === id);
      return { id, name: members.find((user) => user.role === 'CCM')?.name || id, kind: 'Team', ...summarize(members) };
    });
  } else if (scope.type === 'ccm') {
    breakdown = scopeUsers.map((user) => ({ id: user.id, name: user.name, kind: user.role, ...summarize([user]) }));
  } else {
    breakdown = [];
  }

  return {
    scope,
    period: { year, month },
    totals,
    daily,
    outcomes: [...outcomeCounts].map(([outcome, count]) => ({ outcome, count })).filter((entry) => entry.count > 0),
    breakdown,
  };
}

export async function getWorkshopPerformance(req, res) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const tzOffset = Number(req.query.tzOffset || 0);
  const ccmId = req.query.ccmId ? String(req.query.ccmId) : '';
  const creId = req.query.creId ? String(req.query.creId) : '';

  const cacheKey = [year, month, tzOffset, ccmId, creId].join('|');
  let data;
  if (REPORT_CACHE_TTL_MS > 0) {
    const cached = reportCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      data = cached.data;
    } else {
      // Concurrent identical requests share one query.
      let pending = reportInFlight.get(cacheKey);
      if (!pending) {
        pending = queryWorkshopReportsData({ year, month, tzOffset, ccmId, creId })
          .then((result) => {
            if (result && !result.error) rememberReport(cacheKey, result);
            return result;
          })
          .finally(() => reportInFlight.delete(cacheKey));
        reportInFlight.set(cacheKey, pending);
      }
      data = await pending;
    }
  } else {
    data = await queryWorkshopReportsData({ year, month, tzOffset, ccmId, creId });
  }
  if (!data) return res.status(400).json({ message: 'A valid year and month are required.' });
  if (data.error) return res.status(404).json({ message: data.error });

  return res.json(data);
}
