import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { appointmentVisibilityWhere } from '../utils/appointmentAccess.js';
import { evaluateRepairOrderRow } from '../utils/businessRules.js';
import { creCustomerWhere, creVehicleWhere, workshopVisitVisibilityWhere } from '../utils/creAccess.js';
import { normalizeVin } from '../utils/roleAccess.js';
import { addMonths, classifyServiceDue, getLatestServiceDate, getYearlyDueDate, parseStoredDate } from '../utils/serviceDue.js';
import {
  normalizeSaleDate,
  countRemainingFreeServiceMilestones,
  DAILY_TARGETS,
  freeServiceCustomerIdsForMonth,
  buildQuotaRows,
  buildQuotaNotifications,
} from '../utils/serviceCalendar.js';
import { workshopDayRange, workshopMonthOf } from '../utils/workshopTime.js';
import { getCreCallCounts } from '../utils/callMetrics.js';
import { findMissedWarrantyCases } from '../utils/serviceLists.js';
import { lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { recordCreAssignmentEvent, validateAssignmentReason } from '../utils/creAssignmentHistory.js';
import { addCanonicalMasterCallListEntry, buildAllocationQueueRecords, findCanonicalMasterCallListEntry } from '../utils/masterCallList.js';
import { allowedServiceSources, canAccessServiceSource } from '../utils/creServicePermissions.js';
import { classifyMasterRepairType } from '../utils/repairTypes.js';
import { filterMasterCallListRecords, validateMasterCallListFilters } from '../utils/masterCallListFilters.js';
import { filterServiceListRecords, paginateRecords, parsePagination } from '../utils/pagination.js';
import { buildRepairOrderKey, normalizeRepairOrderNo } from '../utils/repairOrderIdentity.js';
import { latestWorkshopVisitOrderBy } from '../utils/workshopVisitOrdering.js';
import { addOriginatingDealerCodes, getOriginatingDealerCodeMap } from '../utils/serviceHistoryDealerCodes.js';
import { findOrCreatePhysicalVehicle } from '../utils/physicalVehicle.js';

const CALL_LIST_QUERY_CHUNK_SIZE = 100;
const RELATED_ID_QUERY_CHUNK_SIZE = 500;
// Keeps each nested Prisma relation load far below PostgreSQL's 32,767 bind-parameter limit.
const CUSTOMER_QUERY_BATCH_SIZE = Math.min(
  Math.max(Number.parseInt(process.env.CUSTOMER_QUERY_BATCH_SIZE, 10) || 500, 1),
  2000,
);

function normalizeRole(role) {
  return String(role || '').toUpperCase();
}

function splitIntoChunks(values, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    chunks.push(values.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function callListMemorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function updateCallListMemoryPeak(peak, sample) {
  for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], sample[key] || 0);
}

function createCallListMemoryTracker() {
  const memory = callListMemorySnapshot();
  return {
    peak: { ...memory },
    metrics: {
      rows: 0,
      canonicalRecords: 0,
      matchingRecords: 0,
      visits: 0,
      memory,
    },
  };
}

function memoryInMegabytes(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

// Opt-in (CUSTOMERS_MEMORY_LOG=true). Logs only counts and process memory, never customer data.
function createCustomerMemoryLogger(enabled = process.env.CUSTOMERS_MEMORY_LOG === 'true') {
  if (!enabled) return () => {};
  const startedAt = Date.now();
  return (phase, counts = {}) => {
    const { rss, heapUsed } = process.memoryUsage();
    console.info('[customers-memory]', JSON.stringify({
      phase,
      ...counts,
      rssMb: memoryInMegabytes(rss),
      heapUsedMb: memoryInMegabytes(heapUsed),
      elapsedMs: Date.now() - startedAt,
    }));
  };
}

function logCallListMemory(phase, metrics, peak = metrics) {
  console.info('[call-list-memory]', JSON.stringify({
    phase,
    rows: metrics.rows,
    canonicalRecords: metrics.canonicalRecords,
    matchingRecords: metrics.matchingRecords,
    visits: metrics.visits,
    memoryMb: Object.fromEntries(
      Object.entries(metrics.memory).map(([key, value]) => [key, memoryInMegabytes(value)]),
    ),
    peakMemoryMb: Object.fromEntries(
      Object.entries(peak).map(([key, value]) => [key, memoryInMegabytes(value)]),
    ),
  }));
}

function importedMobileNumber(visits = []) {
  for (const visit of visits) {
    const details = visit.importedDetails || {};
    for (const key of ['mobileNumber', 'mobile', 'mobileNo', 'phoneNumber', 'phone']) {
      const value = usableMobileNumber(details[key]);
      if (value) return value;
    }
  }
  return null;
}

function importedCustomerDetail(visits = [], keys = []) {
  const wantedKeys = new Set(keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const visit of visits) {
    for (const [key, value] of Object.entries(visit.importedDetails || {})) {
      if (wantedKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
        && value != null && String(value).trim()) {
        return value;
      }
    }
  }
  return null;
}

function usableMobileNumber(value) {
  const mobile = String(value ?? '').trim();
  return mobile && mobile !== '-' && mobile !== '—' ? mobile : null;
}

export function getVisibilityWhere(user) {
  const role = normalizeRole(user?.role);

  if (role === 'ADMIN' || role === 'GM') {
    return {};
  }

  if (role === 'CCM') {
    return { ccmId: user?.ccmId || 'no-access' };
  }

  if (role === 'CRE') {
    return {
      ccmId: user?.ccmId || 'no-access',
      ownerUserId: user?.id || 'no-access',
    };
  }

  return { id: 'no-access' };
}

export async function resolveMasterCallListVisibility(user, requestedCcmId = '', database = prisma) {
  const role = normalizeRole(user?.role);
  if (role === 'ADMIN') return { where: requestedCcmId ? { ccmId: requestedCcmId } : {} };
  if (role !== 'GM') return { where: getVisibilityWhere(user) };

  const teams = await database.user.findMany({
    where: {
      role: 'CCM',
      status: 'active',
      OR: [{ gmId: user?.id || 'no-access' }, { gmId: null }],
    },
    select: { ccmId: true },
  });
  const allowedCcmIds = teams.map(({ ccmId }) => ccmId).filter(Boolean);
  if (requestedCcmId && !allowedCcmIds.includes(requestedCcmId)) {
    return { error: 'You are not permitted to view this CCM team.' };
  }
  if (requestedCcmId) return { where: { ccmId: requestedCcmId } };
  return { where: allowedCcmIds.length ? { ccmId: { in: allowedCcmIds } } : { id: 'no-access' } };
}

export function operationalReadScope(user) {
  const role = normalizeRole(user?.role);
  if (role === 'ADMIN' || role === 'GM') {
    return {
      customer: {},
      vehicle: {},
      call: {},
      appointment: appointmentVisibilityWhere(user),
      followUp: {},
      importBatch: {},
      vinConflict: {},
      allocation: {},
    };
  }
  if (role === 'CCM') {
    const ccmId = user?.ccmId || 'no-access';
    const customer = {
      OR: [{ ccmId }, { vehicles: { some: { ccmId } } }],
    };
    return {
      customer,
      vehicle: { ccmId },
      call: {
        ccmId,
        OR: [
          { vehicleId: null, customer: { is: { ccmId } } },
          { vehicle: { is: { ccmId } } },
        ],
      },
      appointment: appointmentVisibilityWhere(user),
      followUp: {
        ccmId,
        OR: [
          { vehicleId: null, customer: { is: { ccmId } } },
          { vehicle: { is: { ccmId } } },
        ],
      },
      importBatch: { ccmId },
      vinConflict: { targetCcmId: ccmId },
      allocation: { ccmId },
    };
  }
  if (role === 'CRE') {
    const ccmId = user?.ccmId || 'no-access';
    const customer = creCustomerWhere(user);
    const linkedVehicle = {
      OR: [
        { vehicleId: null },
        { vehicle: { is: { ccmId, ...creVehicleWhere(user) } } },
      ],
    };
    return {
      customer,
      vehicle: { ccmId, ...creVehicleWhere(user) },
      call: {
        ccmId,
        createdById: user?.id || 'no-access',
        callSource: { in: allowedServiceSources(user) },
        customer: { is: customer },
        AND: [linkedVehicle],
      },
      appointment: appointmentVisibilityWhere(user),
      followUp: {
        ccmId,
        source: { in: allowedServiceSources(user) },
        customer: { is: customer },
        AND: [linkedVehicle],
      },
      importBatch: { importedByUserId: user?.id || 'no-access' },
      vinConflict: { targetCcmId: ccmId },
      allocation: { ccmId, creId: user?.id || 'no-access' },
    };
  }
  const denied = { id: 'no-access' };
  return {
    customer: denied,
    vehicle: denied,
    call: denied,
    appointment: denied,
    followUp: denied,
    importBatch: denied,
    vinConflict: denied,
    allocation: denied,
  };
}

export async function getDashboardSummary(req, res) {
  const user = req.user;
  const role = normalizeRole(user?.role);
  const now = new Date();
  const dayRange = workshopDayRange(now);
  const monthInfo = workshopMonthOf(now);
  const scope = operationalReadScope(user);
  if (role === 'FREE_SERVICE_CRE') {
    const teamCallScope = {
      ccmId: user.ccmId || 'no-access',
      OR: [
        { vehicleId: null, customer: { is: { ccmId: user.ccmId || 'no-access' } } },
        { vehicle: { is: { ccmId: user.ccmId || 'no-access' } } },
      ],
    };
    const counts = await getCreCallCounts({
      creIds: [user.id],
      start: dayRange.start,
      end: dayRange.end,
      callSources: ['FREE_SERVICE'],
      ccmId: user.ccmId || 'no-access',
      scopeWhere: teamCallScope,
    });
    const activity = counts.get(user.id) || { callsMade: 0, callsPickedUp: 0 };
    const appointments = await prisma.appointment.findMany({
      where: {
        ...appointmentVisibilityWhere(user),
        scheduledAt: { gte: dayRange.start, lt: dayRange.end },
      },
      orderBy: { scheduledAt: 'asc' },
      select: { id: true, customerName: true, vehicleName: true, scheduledAt: true, status: true },
    });
    return res.json({
      role,
      freeServiceCre: {
        dailyTargets: {
          callsMade: { actual: activity.callsMade, target: DAILY_TARGETS.callsMade },
          callsPickedUp: { actual: activity.callsPickedUp, target: DAILY_TARGETS.callsPickedUp },
        },
        todayAppointments: appointments.map((appointment) => ({
          id: appointment.id,
          customer: appointment.customerName,
          vehicle: appointment.vehicleName,
          scheduledAt: appointment.scheduledAt,
          status: appointment.status,
        })),
      },
    });
  }

  const [
    totalCustomers,
    activeVehicles,
    todaysCalls,
    appointmentCount,
    pendingFollowUps,
    totalCalls,
    appointmentCalls,
    importTotals,
    pendingVinConflicts,
    assignedAllocations,
  ] = await Promise.all([
    prisma.customer.count({ where: scope.customer }),
    prisma.vehicle.count({ where: { ...scope.vehicle, status: 'ACTIVE' } }),
    prisma.callLog.count({
      where: {
        ...scope.call,
        createdAt: {
          gte: dayRange.start,
          lt: dayRange.end,
        },
      },
    }),
    prisma.appointment.count({
      where: {
        ...scope.appointment,
        scheduledAt: {
          gte: dayRange.start,
          lt: dayRange.end,
        },
      },
    }),
    prisma.followUp.count({ where: { ...scope.followUp, status: 'pending' } }),
    prisma.callLog.count({ where: scope.call }),
    prisma.callLog.count({ where: { ...scope.call, outcome: 'APPOINTMENT_SET' } }),
    prisma.importBatch.aggregate({ where: scope.importBatch, _sum: { totalRows: true, flaggedRows: true } }),
    prisma.vINConflictReview.count({ where: { ...scope.vinConflict, status: 'pending' } }),
    prisma.allocation.count({ where: { ...scope.allocation, status: 'assigned' } }),
  ]);

  const summary = {
    role,
    totalCustomers,
    activeVehicles,
    todaysCalls,
    appointmentCount,
    conversionRate: totalCalls === 0 ? 0 : Number(((appointmentCalls / totalCalls) * 100).toFixed(1)),
    pendingFollowUps,
    importedRows: importTotals._sum.totalRows || 0,
    flaggedImportRows: importTotals._sum.flaggedRows || 0,
    pendingVinConflicts,
    assignedAllocations,
  };

  if (role === 'CRE') {
    const dueWhere = creDueWhere(user.id, user.ccmId);
    const [scopedRecords, creCounts, followUps, todayAppointments, missedWarranty] = await Promise.all([
      loadCallListRecords(dueWhere, now, user),
      getCreCallCounts({
        creIds: [user.id],
        start: dayRange.start,
        end: dayRange.end,
        callSources: allowedServiceSources(user).filter((source) => source !== 'WARRANTY'),
        ccmId: user.ccmId || 'no-access',
        scopeWhere: {
          ccmId: user.ccmId || 'no-access',
          customer: { is: creCustomerWhere(user) },
          AND: [{
            OR: [
              { vehicleId: null },
              { vehicle: { is: { ccmId: user.ccmId || 'no-access', ...creVehicleWhere(user) } } },
            ],
          }],
        },
      }),
      prisma.followUp.findMany({
        where: {
          status: 'pending',
          ...scope.followUp,
          source: { in: allowedServiceSources(user) },
        },
        include: {
          customer: { select: { id: true, fullName: true, mobileNumber: true } },
          vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
        },
        orderBy: { followUpAt: 'asc' },
        take: 8,
      }),
      prisma.appointment.findMany({
        where: {
          scheduledAt: { gte: dayRange.start, lt: dayRange.end },
          ...appointmentVisibilityWhere(user),
        },
        include: {
          customer: { select: { id: true, fullName: true, mobileNumber: true } },
          vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
      canAccessServiceSource(user, 'WARRANTY')
        ? findMissedWarrantyCases({
          scope: dueWhere,
          vehicleScope: scope.vehicle,
          callScope: scope.call,
          year: monthInfo.year,
          month: monthInfo.month,
          now,
        })
        : Promise.resolve([]),
    ]);

    const cohorts = classifyDueCohorts(scopedRecords, now);
    const freeServiceIds = canAccessServiceSource(user, 'FREE_SERVICE')
      ? freeServiceCustomerIdsForMonth(scopedRecords, monthInfo.year, monthInfo.month, now)
      : new Set();
    const workloadCustomerIds = new Set([
      ...cohorts.oneYear.map((record) => record.customerId),
      ...cohorts.sixMonth.map((record) => record.customerId),
      ...freeServiceIds,
    ].filter(Boolean));

    const dayCallCounts = creCounts.get(user.id) || { callsMade: 0, callsPickedUp: 0 };
    const overdueFollowUpsCount = followUps.filter((f) => new Date(f.followUpAt) < now).length;

    summary.cre = {
      dailyTargets: {
        callsMade: {
          actual: dayCallCounts.callsMade,
          target: DAILY_TARGETS.callsMade,
          met: dayCallCounts.callsMade >= DAILY_TARGETS.callsMade,
          shortfall: Math.max(0, DAILY_TARGETS.callsMade - dayCallCounts.callsMade),
        },
        callsPickedUp: {
          actual: dayCallCounts.callsPickedUp,
          target: DAILY_TARGETS.callsPickedUp,
          met: dayCallCounts.callsPickedUp >= DAILY_TARGETS.callsPickedUp,
          shortfall: Math.max(0, DAILY_TARGETS.callsPickedUp - dayCallCounts.callsPickedUp),
        },
      },
      assignedWorkload: workloadCustomerIds.size,
      categoryCounts: {
        oneYear: cohorts.oneYear.length,
        sixMonth: cohorts.sixMonth.length,
        freeService: canAccessServiceSource(user, 'FREE_SERVICE') ? freeServiceIds.size : null,
        missedWarranty: canAccessServiceSource(user, 'WARRANTY') ? missedWarranty.length : null,
      },
      pendingFollowUps: followUps.length,
      overdueFollowUpsCount,
      urgentFollowUps: followUps.map((f) => ({
        id: f.id,
        customerId: f.customerId,
        customerName: f.customer.fullName,
        mobileNumber: f.customer.mobileNumber,
        vehicleModel: f.vehicle?.model || null,
        vehicleId: f.vehicleId,
        followUpAt: f.followUpAt,
        isOverdue: new Date(f.followUpAt) < now,
        category: f.category,
        notes: f.notes,
        source: f.source,
      })),
      todayAppointments: todayAppointments.map((a) => ({
        id: a.id,
        customer: a.customer?.fullName || a.customerName,
        customerId: a.customerId,
        vehicle: a.vehicle ? [a.vehicle.model, a.vehicle.registrationNumber].filter(Boolean).join(' · ') : a.vehicleName,
        vehicleId: a.vehicleId,
        scheduledAt: a.scheduledAt,
        time: new Date(a.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: a.status,
      })),
      dueServicesCount: countOverdueRecords(scopedRecords, now),
    };
  }

  if (role === 'CCM') {
    const ccmId = user.ccmId || 'no-access';
    const [cres, freeServiceCres, teamAppointments, pendingAllocationsCount, totalTeamVehicles, teamFollowUpsCount] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'CRE', status: 'active', ccmId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.user.findMany({
        where: { role: 'FREE_SERVICE_CRE', status: 'active', ccmId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.appointment.findMany({
        where: { ...scope.appointment, ccmId, scheduledAt: { gte: dayRange.start, lt: dayRange.end } },
        include: {
          customer: { select: { id: true, fullName: true, mobileNumber: true } },
          vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
          assignee: { select: { id: true, name: true } },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
      prisma.masterCallList.count({
        where: { ccmId, ownerUserId: null },
      }),
      prisma.vehicle.count({ where: { ccmId } }),
      prisma.followUp.count({ where: { ...scope.followUp, status: 'pending' } }),
    ]);

    const creIds = cres.map((c) => c.id);
    const prevDayRange = workshopDayRange(now, -1);
    const [todayCounts, prevCounts] = await Promise.all([
      getCreCallCounts({
        creIds,
        start: dayRange.start,
        end: dayRange.end,
        ccmId,
        scopeWhere: scope.call,
      }),
      getCreCallCounts({
        creIds,
        start: prevDayRange.start,
        end: prevDayRange.end,
        ccmId,
        scopeWhere: scope.call,
      }),
    ]);

    const creBoard = buildQuotaRows(cres, todayCounts);
    const prevRows = buildQuotaRows(cres, prevCounts);
    const quotaNotices = {
      date: prevDayRange.dateKey,
      totalCres: cres.length,
      ...buildQuotaNotifications(prevRows),
    };

    summary.ccm = {
      teamCresCount: cres.length,
      teamFreeServiceCresCount: freeServiceCres.length,
      creBoard,
      teamCallsToday: creBoard.reduce((sum, r) => sum + r.callsMade, 0),
      teamCallsPickedUpToday: creBoard.reduce((sum, r) => sum + r.callsPickedUp, 0),
      pendingAllocationsCount,
      totalTeamVehicles,
      teamFollowUpsCount,
      quotaNotices,
      todayAppointments: teamAppointments.map((a) => ({
        id: a.id,
        customer: a.customer?.fullName || a.customerName,
        customerId: a.customerId,
        vehicle: a.vehicle ? [a.vehicle.model, a.vehicle.registrationNumber].filter(Boolean).join(' · ') : a.vehicleName,
        vehicleId: a.vehicleId,
        scheduledAt: a.scheduledAt,
        time: new Date(a.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        assigneeName: a.assignee?.name || 'Unassigned',
        status: a.status,
      })),
    };
  }

  if (role === 'GM') {
    const ccms = await prisma.user.findMany({
      where: { role: 'CCM', status: 'active', ...(user.id ? { OR: [{ gmId: user.id }, { gmId: null }] } : {}) },
      select: { id: true, name: true, ccmId: true },
      orderBy: { name: 'asc' },
    });

    const [todayCallsTotal, todayPickedUpTotal, appointmentStatusGroups, teamBreakdowns, todayAppointments] = await Promise.all([
      prisma.callLog.count({ where: { createdAt: { gte: dayRange.start, lt: dayRange.end }, callSource: { not: 'WARRANTY' } } }),
      prisma.callLog.count({
        where: {
          createdAt: { gte: dayRange.start, lt: dayRange.end },
          callSource: { not: 'WARRANTY' },
          outcome: { in: ['CONTACTED', 'CALLBACK', 'NOT_INTERESTED', 'APPOINTMENT_SET', 'FOLLOW_UP_LATER', 'OTHER'] },
        },
      }),
      prisma.appointment.groupBy({
        by: ['status'],
        where: { scheduledAt: { gte: dayRange.start, lt: dayRange.end } },
        _count: { _all: true },
      }),
      Promise.all(ccms.map(async (ccm) => {
        const teamCcmId = ccm.ccmId || '';
        const cres = await prisma.user.findMany({ where: { role: 'CRE', status: 'active', ccmId: teamCcmId }, select: { id: true } });
        const creIds = cres.map((c) => c.id);
        const [counts, appts, vehicles] = await Promise.all([
          getCreCallCounts({ creIds, start: dayRange.start, end: dayRange.end }),
          prisma.appointment.count({ where: { ccmId: teamCcmId, scheduledAt: { gte: dayRange.start, lt: dayRange.end } } }),
          prisma.vehicle.count({ where: { ccmId: teamCcmId } }),
        ]);
        const callsMade = [...counts.values()].reduce((sum, c) => sum + c.callsMade, 0);
        const callsPickedUp = [...counts.values()].reduce((sum, c) => sum + c.callsPickedUp, 0);
        return {
          id: ccm.id,
          ccmId: teamCcmId,
          name: ccm.name,
          creCount: cres.length,
          vehiclesCount: vehicles,
          callsMade,
          callsPickedUp,
          appointmentsToday: appts,
        };
      })),
      prisma.appointment.findMany({
        where: { scheduledAt: { gte: dayRange.start, lt: dayRange.end } },
        include: {
          customer: { select: { id: true, fullName: true } },
          vehicle: { select: { model: true, registrationNumber: true } },
          assignee: { select: { name: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 8,
      }),
    ]);

    summary.gm = {
      todayCallsTotal,
      todayPickedUpTotal,
      appointmentStatusCounts: Object.fromEntries(appointmentStatusGroups.map((g) => [g.status, g._count._all])),
      teamBreakdowns,
      todayAppointments: todayAppointments.map((a) => ({
        id: a.id,
        customer: a.customer?.fullName || a.customerName,
        vehicle: a.vehicle ? [a.vehicle.model, a.vehicle.registrationNumber].filter(Boolean).join(' · ') : a.vehicleName,
        time: new Date(a.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        assigneeName: a.assignee?.name || 'Unassigned',
        status: a.status,
      })),
    };
  }

  if (role === 'ADMIN') {
    const [allUsers, recentBatches, recentAuditLogs] = await Promise.all([
      prisma.user.findMany({ select: { role: true, status: true } }),
      prisma.importBatch.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, fileName: true, totalRows: true, createdRows: true, appendedRows: true, skippedRows: true, rejectedRows: true, flaggedRows: true, status: true, createdAt: true },
      }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: { select: { name: true, username: true } } },
      }),
    ]);

    const activeUsers = allUsers.filter((u) => String(u.status || '').toLowerCase() === 'active');
    const byRole = {
      admin: allUsers.filter((u) => String(u.role || '').toUpperCase() === 'ADMIN').length,
      gm: allUsers.filter((u) => String(u.role || '').toUpperCase() === 'GM').length,
      ccm: allUsers.filter((u) => String(u.role || '').toUpperCase() === 'CCM').length,
      cre: allUsers.filter((u) => String(u.role || '').toUpperCase() === 'CRE').length,
      freeServiceCre: allUsers.filter((u) => String(u.role || '').toUpperCase() === 'FREE_SERVICE_CRE').length,
    };
    const activeByRole = {
      admin: activeUsers.filter((u) => String(u.role || '').toUpperCase() === 'ADMIN').length,
      gm: activeUsers.filter((u) => String(u.role || '').toUpperCase() === 'GM').length,
      ccm: activeUsers.filter((u) => String(u.role || '').toUpperCase() === 'CCM').length,
      cre: activeUsers.filter((u) => String(u.role || '').toUpperCase() === 'CRE').length,
      freeServiceCre: activeUsers.filter((u) => String(u.role || '').toUpperCase() === 'FREE_SERVICE_CRE').length,
    };

    const userStats = {
      total: allUsers.length,
      active: activeUsers.length,
      inactive: allUsers.length - activeUsers.length,
      byRole,
      activeByRole,
      ...byRole,
    };

    summary.admin = {
      userStats,
      recentBatches,
      recentAuditLogs: recentAuditLogs.map((log) => ({
        id: log.id,
        actor: log.user?.name || log.user?.username || 'System',
        action: log.action,
        entityType: log.entityType,
        details: log.details,
        createdAt: log.createdAt,
      })),
    };
  }

  return res.json(summary);
}

function getAgeInMonths(saleDate, now) {
  if (!saleDate || saleDate > now) return null;
  let months = (now.getFullYear() - saleDate.getFullYear()) * 12 + now.getMonth() - saleDate.getMonth();
  if (now.getDate() < saleDate.getDate()) months -= 1;
  return Math.max(0, months);
}

export async function loadCallListRecords(
  where,
  now = new Date(),
  user = null,
  {
    trackMemory = false,
    memoryTracker: providedMemoryTracker = null,
    page: pageOptions = null,
    filters = null,
    allocationQueueRecords = [],
  } = {},
) {
  const role = normalizeRole(user?.role);
  const ccmId = user?.ccmId || 'no-access';
  const allocationWhere = role === 'ADMIN' || role === 'GM'
    ? { status: 'assigned' }
    : role === 'CCM'
      ? { status: 'assigned', ccmId }
      : role === 'CRE'
        ? { status: 'assigned', ccmId, creId: user?.id || 'no-access' }
        : { id: 'no-access' };
  const monthlyEntryWhere = role === 'ADMIN' || role === 'GM'
    ? {}
    : role === 'CCM' || role === 'CRE'
      ? { dataset: { is: { ccmId } } }
      : { id: 'no-access' };
  const visitWhere = workshopVisitVisibilityWhere(user);
  const appointmentWhere = appointmentVisibilityWhere(user || {});
  const upcomingAppointmentWhere = {
    scheduledAt: { gte: now },
    status: { in: ['PENDING', 'CONFIRMED', 'RESCHEDULED'] },
  };
  const select = {
    id: true,
    createdAt: true,
    ccmId: true,
    ownerUserId: true,
    customerName: true,
    mobileNumber: true,
    vin: true,
    status: true,
    registrationNumber: true,
    vehicle: {
      select: {
        id: true,
        customerId: true,
        model: true,
        saleDate: true,
        registrationNumber: true,
        physicalVehicleId: true,
        physicalVehicle: {
          select: {
            workshopVisits: {
              where: visitWhere,
              orderBy: latestWorkshopVisitOrderBy,
              select: {
                id: true,
                repairOrderNo: true,
                ccmId: true,
                visitDate: true,
                closingDate: true,
                gpDate: true,
                totalLaborCost: true,
                totalPartsCost: true,
                totalAmount: true,
                importedDetails: true,
              },
            },
          },
        },
        allocations: {
          where: allocationWhere,
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { serviceType: true },
        },
        monthlyDataEntries: {
          where: {
            ...monthlyEntryWhere,
            OR: [
              { serviceType: { not: null } },
              { nextServiceDueDate: { not: null } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { serviceType: true, nextServiceDueDate: true },
        },
        appointments: {
          where: { ...upcomingAppointmentWhere, ...appointmentWhere },
          orderBy: { scheduledAt: 'asc' },
          take: 1,
          select: { id: true, scheduledAt: true, status: true },
        },
        customer: {
          select: {
            appointments: {
              where: { ...upcomingAppointmentWhere, ...appointmentWhere, vehicleId: null },
              orderBy: { scheduledAt: 'asc' },
              take: 1,
              select: { id: true, scheduledAt: true, status: true },
            },
          },
        },
      },
    },
  };
  const canonicalRecords = new Map();
  const canonicalMatches = pageOptions ? new Map() : null;
  const allocationQueueVinKeys = new Set(
    allocationQueueRecords.map((record) => `${record.ccmId}\u0000${record.vin}`),
  );
  const ownerIds = new Set();
  const ownerNames = new Map();
  const dealerCodeByCcmId = new Map();
  const memoryTracker = providedMemoryTracker || (trackMemory ? createCallListMemoryTracker() : null);
  if (memoryTracker) logCallListMemory('start', memoryTracker.metrics, memoryTracker.peak);
  let processedRows = 0;
  let processedVisits = 0;
  let loggedFirstChunk = false;
  let cursor = null;
  while (true) {
    const pageWhere = cursor
      ? {
        AND: [
          where,
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ],
      }
      : where;
    const page = await prisma.masterCallList.findMany({
      where: pageWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CALL_LIST_QUERY_CHUNK_SIZE,
      select,
    });
    if (!page.length) break;
    if (memoryTracker) {
      const sample = callListMemorySnapshot();
      updateCallListMemoryPeak(memoryTracker.peak, sample);
      memoryTracker.metrics.memory = sample;
    }
    const lastRow = page.at(-1);
    const hasMoreRows = page.length === CALL_LIST_QUERY_CHUNK_SIZE;
    if (hasMoreRows) cursor = { createdAt: lastRow.createdAt, id: lastRow.id };

    const visitCcmIds = new Set();
    for (const row of page) {
      if (!pageOptions && row.ownerUserId) {
        ownerIds.add(row.ownerUserId);
      }
      for (const visit of row.vehicle?.physicalVehicle?.workshopVisits || []) {
        if (memoryTracker) processedVisits += 1;
        if (!pageOptions && visit.ccmId) visitCcmIds.add(visit.ccmId);
      }
    }

    const uncachedVisitCcmIds = pageOptions
      ? []
      : [...visitCcmIds].filter((visitCcmId) => !dealerCodeByCcmId.has(visitCcmId));
    const pageDealerCodes = pageOptions ? new Map() : await getOriginatingDealerCodeMap(uncachedVisitCcmIds);
    for (const visitCcmId of uncachedVisitCcmIds) {
      dealerCodeByCcmId.set(visitCcmId, pageDealerCodes.get(visitCcmId) || null);
    }
    const previousRows = processedRows;
    for (const row of page) {
      const visits = row.vehicle?.physicalVehicle?.workshopVisits || [];
      const record = {
        id: row.id,
        createdAt: row.createdAt,
        customerId: row.vehicle?.customerId || null,
        vehicleId: row.vehicle?.id || null,
        name: row.customerName,
        customerName: row.customerName,
        vin: row.vin,
        mobile: usableMobileNumber(row.mobileNumber) || importedMobileNumber(visits),
        model: row.vehicle?.model || null,
        vehicleAgeMonths: getAgeInMonths(
          row.vehicle?.saleDate
            || visits.map((visit) => parseStoredDate(visit.importedDetails?.saleDate)).find(Boolean),
          now,
        ),
        registrationNumber: row.registrationNumber || row.vehicle?.registrationNumber || null,
        saleDate: row.vehicle?.saleDate || null,
        type: classifyMasterRepairType(visits[0]?.importedDetails?.workType
          || row.vehicle?.monthlyDataEntries[0]?.serviceType
          || row.vehicle?.allocations[0]?.serviceType),
        dueCategory: classifyServiceDue(getLatestServiceDate(visits, now), now),
        dueDate: getYearlyDueDate(visits)
          || row.vehicle?.monthlyDataEntries[0]?.nextServiceDueDate
          || null,
        scheduledAppointment: [
          ...(row.vehicle?.appointments || []),
          ...(row.vehicle?.customer?.appointments || []),
        ].sort((left, right) => left.scheduledAt - right.scheduledAt)[0] || null,
        ccm: row.ccmId || 'Unassigned',
        status: row.status,
        assigneeId: row.ownerUserId,
        assigneeName: null,
        ccmId: row.ccmId,
        importedDetails: visits[0]?.importedDetails || null,
        physicalVehicleId: row.vehicle?.physicalVehicleId || null,
        workshopVisits: visits.map((visit) => ({
          ...visit,
          dealerCode: dealerCodeByCcmId.get(visit.ccmId) || null,
        })),
      };
      if (pageOptions) {
        const key = `${record.ccmId}\u0000${record.vin}`;
        const compactRecord = {
          ...record,
          importedDetails: null,
          workshopVisits: [],
          allocationQueue: !record.assigneeId && allocationQueueVinKeys.has(key),
        };
        const matches = filterMasterCallListRecords([record], filters, user?.role).length > 0;
        addCanonicalMasterCallListEntry(canonicalRecords, compactRecord);
        if (canonicalRecords.get(key) === compactRecord) {
          canonicalMatches.set(key, matches);
        }
      } else {
        addCanonicalMasterCallListEntry(canonicalRecords, record);
      }
      if (memoryTracker) processedRows += 1;
    }

    page.length = 0;
    visitCcmIds.clear();
    pageDealerCodes.clear();
    uncachedVisitCcmIds.length = 0;
    if (memoryTracker) {
      const sample = callListMemorySnapshot();
      updateCallListMemoryPeak(memoryTracker.peak, sample);
      memoryTracker.metrics.rows = processedRows;
      memoryTracker.metrics.canonicalRecords = canonicalRecords.size;
      memoryTracker.metrics.visits = processedVisits;
      memoryTracker.metrics.memory = sample;
      if (!loggedFirstChunk || Math.floor(processedRows / 1000) > Math.floor(previousRows / 1000)) {
        logCallListMemory('processing', memoryTracker.metrics, memoryTracker.peak);
        loggedFirstChunk = true;
      }
    }
    if (!hasMoreRows) break;
  }

  for (const chunk of splitIntoChunks([...ownerIds], RELATED_ID_QUERY_CHUNK_SIZE)) {
    const owners = await prisma.user.findMany({
      where: { id: { in: chunk } },
      select: { id: true, name: true },
    });
    for (const owner of owners) ownerNames.set(owner.id, owner.name);
  }
  if (pageOptions) {
    for (const queueRecord of allocationQueueRecords) {
      const key = `${queueRecord.ccmId}\u0000${queueRecord.vin}`;
      if (canonicalRecords.has(key)) {
        const canonical = canonicalRecords.get(key);
        if (!canonical.assigneeId) canonical.allocationQueue = true;
        continue;
      }
      if (!canonicalMatches.has(key)) {
        canonicalRecords.set(key, queueRecord);
        canonicalMatches.set(
          key,
          filterMasterCallListRecords([queueRecord], filters, user?.role).length > 0,
        );
      }
    }

    const matchingRecords = [];
    for (const [key, record] of canonicalRecords) {
      if (canonicalMatches.get(key)) matchingRecords.push(record);
    }
    matchingRecords.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)
      || String(left.id).localeCompare(String(right.id)));
    const total = matchingRecords.length;
    const pageRecords = matchingRecords.slice(pageOptions.offset, pageOptions.offset + pageOptions.limit);
    matchingRecords.length = 0;
    const ownerPageIds = new Set();
    for (const record of pageRecords) {
      if (record.assigneeId) ownerPageIds.add(record.assigneeId);
    }
    const pageOwnerNames = new Map();
    for (const chunk of splitIntoChunks([...ownerPageIds], RELATED_ID_QUERY_CHUNK_SIZE)) {
      const owners = await prisma.user.findMany({
        where: { id: { in: chunk } },
        select: { id: true, name: true },
      });
      for (const owner of owners) pageOwnerNames.set(owner.id, owner.name);
    }
    const records = pageRecords.map((record) => ({
      ...record,
      assigneeName: pageOwnerNames.get(record.assigneeId) || null,
    }));
    const hasMore = pageOptions.offset + records.length < total;
    canonicalRecords.clear();
    canonicalMatches.clear();
    if (memoryTracker) {
      const finalSample = callListMemorySnapshot();
      updateCallListMemoryPeak(memoryTracker.peak, finalSample);
      memoryTracker.metrics.rows = processedRows;
      memoryTracker.metrics.canonicalRecords = total;
      memoryTracker.metrics.matchingRecords = total;
      memoryTracker.metrics.visits = processedVisits;
      memoryTracker.metrics.memory = finalSample;
      logCallListMemory('complete', memoryTracker.metrics, memoryTracker.peak);
    }
    return { records, total, limit: pageOptions.limit, offset: pageOptions.offset, hasMore };
  }

  const records = [...canonicalRecords.values()];
  for (const record of records) record.assigneeName = ownerNames.get(record.assigneeId) || null;

  ownerIds.clear();
  ownerNames.clear();
  dealerCodeByCcmId.clear();
  canonicalRecords.clear();
  if (memoryTracker) {
    const finalSample = callListMemorySnapshot();
    updateCallListMemoryPeak(memoryTracker.peak, finalSample);
    memoryTracker.metrics.rows = processedRows;
    memoryTracker.metrics.canonicalRecords = records.length;
    memoryTracker.metrics.visits = processedVisits;
    memoryTracker.metrics.memory = finalSample;
    logCallListMemory('complete', memoryTracker.metrics, memoryTracker.peak);
  }
  return records;
}

export async function getCallList(req, res) {
  if (normalizeRole(req.user?.role) === 'FREE_SERVICE_CRE') {
    return res.status(403).json({ message: 'Free-Service CRE accounts cannot access the Master Call List.' });
  }
  const validated = validateMasterCallListFilters(req.query);
  if (validated.error) return res.status(400).json({ message: validated.error });
  const paginationResult = parsePagination(req.query);
  if (paginationResult.error) return res.status(400).json({ message: paginationResult.error });
  const role = normalizeRole(req.user?.role);
  const scope = await resolveMasterCallListVisibility(
    req.user,
    ['ADMIN', 'GM'].includes(role) ? String(req.query.ccmId || '').trim() : '',
  );
  if (scope.error) return res.status(403).json({ message: scope.error });
  const memoryTracker = createCallListMemoryTracker();
  let allocationQueueRecords = [];
  if (normalizeRole(req.user?.role) === 'CCM') {
    const ccmId = req.user?.ccmId || 'no-access';
    const unassignedAllocations = await prisma.allocation.findMany({
      where: { ccmId, status: 'assigned', creId: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        ccmId: true,
        serviceType: true,
        vehicle: {
          select: {
            id: true,
            vin: true,
            model: true,
            registrationNumber: true,
            customer: { select: { id: true } },
          },
        },
      },
    });
    allocationQueueRecords = buildAllocationQueueRecords([], unassignedAllocations, ccmId);
  }
  const response = await loadCallListRecords(
    scope.where,
    new Date(),
    req.user,
    {
      memoryTracker,
      page: paginationResult,
      filters: validated.filters,
      allocationQueueRecords,
    },
  );
  memoryTracker.metrics.matchingRecords = response.total;
  let sample = callListMemorySnapshot();
  updateCallListMemoryPeak(memoryTracker.peak, sample);
  memoryTracker.metrics.memory = sample;
  logCallListMemory('filtered', memoryTracker.metrics, memoryTracker.peak);
  logCallListMemory('response-ready', memoryTracker.metrics, memoryTracker.peak);
  return res.json(response);
}

// The MasterCallList scope for one CRE's own due-list and performance figures: vehicles they
// directly own on the master list, or that are actively allocated to them.
export function creDueWhere(creId, ccmId) {
  return {
    ccmId: ccmId || 'no-access',
    OR: [
      { ownerUserId: creId || 'no-access' },
      { vehicle: { is: { allocations: { some: { creId: creId || 'no-access', ccmId: ccmId || 'no-access', status: 'assigned' } } } } },
    ],
  };
}

// Classifies loaded records into a due cohort ('1y' or '6m') as of `asOf`, so the same logic can
// recompute a past month's cohort for performance history, not just "right now".
export async function loadDueRecords(where, dueWindow, asOf = new Date(), user = null) {
  const cohorts = await loadDueCohorts(where, asOf, user);
  return dueWindow === '1y' ? cohorts.oneYear : cohorts.sixMonth;
}

// Both cohorts from a single load of the master call list.
export async function loadDueCohorts(where, asOf = new Date(), user = null) {
  return classifyDueCohorts(await loadCallListRecords(where, asOf, user), asOf);
}

export function classifyDueCohorts(records, asOf = new Date()) {
  const classified = records
    .map((record) => ({ record, lastServiceDate: getLatestServiceDate(record.workshopVisits, asOf) }))
    .map((entry) => ({ ...entry, window: classifyServiceDue(entry.lastServiceDate, asOf) }));
  const cohort = (window) => classified
    .filter((entry) => entry.window === window)
    .map(({ record, lastServiceDate }) => ({
      ...record,
      lastServiceDate,
      dueDate: addMonths(lastServiceDate, window === '1y' ? 12 : 6),
    }))
    .sort((left, right) => left.dueDate - right.dueDate || String(left.id).localeCompare(String(right.id)));
  return { oneYear: cohort('1y'), sixMonth: cohort('6m') };
}

// A live (not month-scoped) count of master-call-list records whose service due date has already
// passed, shown as the "Due services" performance card. This intentionally does not reset monthly,
// unlike the 1-Year/6-Month Due cohorts.
export function countOverdueRecords(records, now = new Date()) {
  return records.filter((record) => record.dueDate && new Date(record.dueDate) < now).length;
}

// Only the CRE's own assigned vehicles (or, for a CCM, their whole team), classified from the
// latest dated repair order.
export async function getDueCallList(req, res) {
  const dueWindow = req.query.window;
  if (!['1y', '6m'].includes(dueWindow)) {
    return res.status(400).json({ message: 'window must be 1y or 6m.' });
  }
  const paginationResult = parsePagination(req.query);
  if (paginationResult.error) return res.status(400).json({ message: paginationResult.error });

  const role = normalizeRole(req.user?.role);
  const where = role === 'CCM'
    ? { ccmId: req.user?.ccmId || 'no-access' }
    : creDueWhere(req.user?.id, req.user?.ccmId);
  const due = await loadDueRecords(where, dueWindow, new Date(), req.user);
  const filtered = filterServiceListRecords(due, req.query);
  if (filtered.error) return res.status(400).json({ message: filtered.error });
  if (!paginationResult.hasPagination) return res.json({ records: filtered.records });
  return res.json(paginateRecords(filtered.records, paginationResult));
}

export async function updateCallListAssignee(req, res) {
  const reasonValidation = validateAssignmentReason(req.body?.reason);
  if (reasonValidation.error) return res.status(400).json({ message: reasonValidation.error });
  const reason = reasonValidation.value;
  const entry = await prisma.masterCallList.findFirst({
    where: { id: req.params.id, ccmId: req.user.ccmId || 'no-access' },
    select: { id: true, ccmId: true, ownerUserId: true, vin: true, vehicle: { select: { id: true, ccmId: true } } },
  });
  if (!entry) return res.status(404).json({ message: 'Allocated customer not found.' });
  if (!entry.vehicle) return res.status(409).json({ message: 'The call-list vehicle no longer exists.' });
  if (!entry.vehicle.ccmId || entry.vehicle.ccmId !== entry.ccmId) {
    return res.status(409).json({ message: 'The call-list CCM does not own this vehicle.' });
  }

  const assigneeId = req.body?.assigneeId == null || req.body.assigneeId === ''
    ? null
    : String(req.body.assigneeId).trim();
  if (!assigneeId) return res.status(400).json({ message: 'Choose an active CRE assigned to your team.' });

  const updated = await prisma.$transaction(async (transaction) => {
    await lockCcmAllocationTeam(transaction, entry.ccmId);
    const currentEntry = await transaction.masterCallList.findFirst({
      where: { id: entry.id, ccmId: entry.ccmId },
      select: { id: true, ownerUserId: true, vin: true, vehicle: { select: { id: true, ccmId: true } } },
    });
    if (!currentEntry?.vehicle || currentEntry.vehicle.ccmId !== entry.ccmId) return 'ownership-conflict';
    const assignee = await transaction.user.findFirst({
      where: { id: assigneeId, role: 'CRE', status: 'active', ccmId: entry.ccmId },
      select: { id: true, name: true },
    });
    if (!assignee) return null;
    const previousCreId = currentEntry.ownerUserId;
    const record = await transaction.masterCallList.update({
      where: { id: currentEntry.id },
      data: { ownerUserId: assignee.id, assignmentNeedsReview: false },
    });
    await recordCreAssignmentEvent(transaction, {
      vehicleId: currentEntry.vehicle.id,
      masterCallListId: record.id,
      ccmId: entry.ccmId,
      previousCreId,
      newCreId: assignee.id,
      actorUserId: req.user.id,
      reason,
    });
    // Active allocations follow the Master Call List owner so the previous CRE loses access.
    const allocationScope = { status: 'assigned', vehicle: { is: { vin: currentEntry.vin } }, ccmId: entry.ccmId };
    const allocations = await transaction.allocation.findMany({
      where: allocationScope,
      select: { id: true, vehicleId: true, creId: true },
    });
    for (const allocation of allocations) {
      if (allocation.creId === assignee.id) continue;
      const previousCreId = allocation.creId;
      await transaction.allocation.update({
        where: { id: allocation.id },
        data: { creId: assignee.id, assignmentNeedsReview: false },
      });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: allocation.vehicleId,
        allocationId: allocation.id,
        ccmId: entry.ccmId,
        previousCreId,
        newCreId: assignee.id,
        actorUserId: req.user.id,
        reason,
      });
    }
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'MasterCallList',
        entityId: record.id,
        action: 'CRE_REASSIGNED',
        details: JSON.stringify({
          previousAssigneeId: currentEntry.ownerUserId,
          assigneeId: assignee.id,
        }),
      },
    });
    return { record, assignee };
  });
  if (updated === 'ownership-conflict') {
    return res.status(409).json({ message: 'Call-list vehicle ownership changed before reassignment.' });
  }
  if (!updated) return res.status(400).json({ message: 'Choose an active CRE assigned to your team.' });

  return res.json({
    record: {
      id: updated.record.id,
      assigneeId: updated.record.ownerUserId,
      assigneeName: updated.assignee.name,
    },
  });
}

export async function createManualCallListEntry(req, res) {
  const row = req.body || {};
  const roNumber = String(row.roNumber || '').trim();
  const vin = normalizeVin(row.vin || '');
  const customerName = String(row.customerName || '').trim();
  const mobileNumber = String(row.mobileNumber || '').trim();
  const role = normalizeRole(req.user?.role);
  const requestedCcmId = String(row.ccmId || '').trim();
  if (!['ADMIN', 'GM', 'CCM'].includes(role)) {
    return res.status(403).json({ message: 'You are not permitted to create workshop records.' });
  }
  if (role === 'CCM' && requestedCcmId && requestedCcmId !== req.user.ccmId) {
    return res.status(403).json({ message: 'CCM users may only create records for their authenticated CCM.' });
  }
  const ccmId = role === 'CCM' ? String(req.user.ccmId || '').trim() : requestedCcmId;
  const laborCost = row.totalLaborCost == null || String(row.totalLaborCost).trim() === ''
    ? null
    : Number(row.totalLaborCost);
  const partsCost = row.totalPartsCost == null || String(row.totalPartsCost).trim() === ''
    ? null
    : Number(row.totalPartsCost);
  const visitDate = row.visitDate == null || String(row.visitDate).trim() === ''
    ? null
    : new Date(row.visitDate);
  const closingDate = row.closingDate == null || String(row.closingDate).trim() === ''
    ? null
    : new Date(row.closingDate);
  const gpDate = row.gpDate == null || String(row.gpDate).trim() === ''
    ? null
    : new Date(row.gpDate);
  const saleDate = row.saleDate == null || String(row.saleDate).trim() === ''
    ? null
    : new Date(row.saleDate);
  const ucSaleDate = row.ucSaleDate == null || String(row.ucSaleDate).trim() === ''
    ? null
    : new Date(row.ucSaleDate);
  const mileage = row.mileage == null || String(row.mileage).trim() === ''
    ? null
    : Number(String(row.mileage).replaceAll(',', '').trim());
  const year = row.year == null || String(row.year).trim() === '' ? null : Number(row.year);

  if (!roNumber || !vin || !customerName || !mobileNumber) {
    return res.status(400).json({ message: 'RO Number, VIN, Customer Name, and Mobile are required.' });
  }
  if (roNumber.length > 255 || customerName.length > 200 || mobileNumber.length > 50) {
    return res.status(400).json({ message: 'RO Number, Customer Name, or Mobile is too long.' });
  }
  if ((laborCost != null && (!Number.isFinite(laborCost) || laborCost < 0))
    || (partsCost != null && (!Number.isFinite(partsCost) || partsCost < 0))) {
    return res.status(400).json({ message: 'Labor and parts costs must be non-negative numbers.' });
  }
  if ([visitDate, closingDate, gpDate, saleDate, ucSaleDate].some((date) => date && Number.isNaN(date.getTime()))) {
    return res.status(400).json({ message: 'A repair-order, closing, G.P., sale, or UC sale date is invalid.' });
  }
  if (mileage != null && (!Number.isFinite(mileage) || mileage < 0)) {
    return res.status(400).json({ message: 'Mileage must be a non-negative number.' });
  }
  if (year != null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1)) {
    return res.status(400).json({ message: 'Year is invalid.' });
  }

  if (!ccmId) {
    return res.status(400).json({ message: 'Select an active CCM assignment.' });
  }
  const activeCcm = await prisma.user.findFirst({
    where: { role: 'CCM', ccmId, status: 'active' },
    select: { ccmId: true },
  });
  if (!activeCcm) return res.status(400).json({ message: 'CCM assignment is invalid.' });

  const [vehicleOwner, matchingVisits] = await Promise.all([
    prisma.vehicle.findFirst({
      where: { vin, ccmId },
      select: { id: true, registrationNumber: true },
    }),
    prisma.workshopVisit.findMany({
      where: { ccmId, normalizedRepairOrderNo: normalizeRepairOrderNo(roNumber) },
      include: { vehicle: { select: { vin: true } } },
    }),
  ]);
  const registrationNumber = String(row.registrationNumber || '').trim().toUpperCase();
  const registrationOwner = registrationNumber
    ? await prisma.vehicle.findFirst({
      where: {
        registrationNumber: { equals: registrationNumber, mode: 'insensitive' },
        ccmId,
        vin: { not: vin },
      },
      select: { id: true },
    })
    : null;
  if (registrationOwner) {
    return res.status(409).json({ message: 'This registration number is already assigned to another vehicle.' });
  }
  if (vehicleOwner && registrationNumber && vehicleOwner.registrationNumber
    && vehicleOwner.registrationNumber.trim().toUpperCase() !== registrationNumber) {
    return res.status(409).json({ message: 'Registration number does not match the existing VIN record.' });
  }
  const repairOrder = matchingVisits[0];
  const existingKeys = new Map(matchingVisits.map((visit) => [
    buildRepairOrderKey(visit.ccmId, visit.normalizedRepairOrderNo),
    normalizeVin(visit.vehicle.vin),
  ]));
  const result = evaluateRepairOrderRow({
    ...row,
    vin,
    roNumber,
    ccmId,
    ownerCcmId: ccmId,
  }, existingKeys);
  if (result.status === 'skipped') {
    return res.status(409).json({ message: 'This repair order number is already in the system.' });
  }
  if (result.status === 'rejected') {
    return res.status(400).json({ message: result.reason });
  }
  if (result.status === 'flagged') {
    await prisma.vINConflictReview.create({
      data: {
        vin,
        sourceCcmId: ccmId,
        targetCcmId: ccmId,
        reason: result.reason,
      },
    });
    return res.status(409).json({ message: 'This VIN belongs to another CCM team and requires conflict review.' });
  }
  if (repairOrder && repairOrder.vehicle.vin !== vin) {
    return res.status(409).json({ message: 'This repair order number is already in use for another VIN.' });
  }
  try {
    const record = await prisma.$transaction(async (transaction) => {
      await lockCcmAllocationTeam(transaction, ccmId);
      const physicalVehicle = await findOrCreatePhysicalVehicle(transaction, vin);
      let vehicle = await transaction.vehicle.findFirst({ where: { vin, ccmId }, include: { customer: true } });
      let customer = vehicle?.customer;

      if (!customer) {
        customer = await transaction.customer.create({
          data: {
            customerCode: `CUS-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
            fullName: customerName,
            mobileNumber,
            email: String(row.email || '').trim().toLowerCase() || null,
            ccmId,
          },
        });
      }

      if (!vehicle) {
        vehicle = await transaction.vehicle.create({
          data: {
            vin,
            physicalVehicleId: physicalVehicle.id,
            registrationNumber: String(row.registrationNumber || '').trim().toUpperCase() || null,
            make: String(row.make || '').trim() || null,
            model: String(row.model || '').trim() || null,
            variant: String(row.variant || '').trim() || null,
            year: year || (saleDate ? saleDate.getFullYear() : null),
            saleDate: normalizeSaleDate(saleDate),
            customerId: customer.id,
            ccmId,
          },
        });
      } else if (vehicle.ccmId !== ccmId) {
        throw Object.assign(new Error('Existing VIN ownership does not match the selected CCM.'), { code: 'IDENTITY_CONFLICT' });
      } else if (!vehicle.registrationNumber && registrationNumber) {
        vehicle = await transaction.vehicle.update({
          where: { id: vehicle.id },
          data: { registrationNumber },
          include: { customer: true },
        });
      }
      if (!vehicle.saleDate && normalizeSaleDate(saleDate)) {
        vehicle = await transaction.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: normalizeSaleDate(saleDate) }, include: { customer: true } });
      }

      await transaction.workshopVisit.create({
        data: {
          repairOrderNo: roNumber,
          normalizedRepairOrderNo: normalizeRepairOrderNo(roNumber),
          customerId: customer.id,
          vehicleId: vehicle.id,
          physicalVehicleId: physicalVehicle.id,
          ccmId,
          totalLaborCost: laborCost,
          totalPartsCost: partsCost,
          totalAmount: laborCost == null && partsCost == null ? null : (laborCost || 0) + (partsCost || 0),
          visitDate,
          closingDate,
          gpDate,
          importedDetails: { ...row, ccmId },
        },
      });

      const existingEntry = await findCanonicalMasterCallListEntry(transaction, vin, ccmId);
      const callListEntry = existingEntry
        ? await transaction.masterCallList.update({
          where: { id: existingEntry.id },
          data: { customerName, mobileNumber, registrationNumber: vehicle.registrationNumber, vehicleId: vehicle.id },
        })
        : await transaction.masterCallList.create({
          data: {
            customerName,
            mobileNumber,
            vin,
            vehicleId: vehicle.id,
            registrationNumber: vehicle.registrationNumber,
            ccmId,
          },
        });

      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          entityType: 'MasterCallList',
          entityId: callListEntry.id,
          action: 'MANUAL_CUSTOMER_ADDED',
          details: JSON.stringify({ roNumber, vin, ccmId }),
        },
      });

      return {
        id: callListEntry.id,
        name: customerName,
        customerName,
        vin,
        mobile: mobileNumber,
        model: vehicle.model,
        vehicleAgeMonths: getAgeInMonths(saleDate, new Date()),
        registrationNumber: vehicle.registrationNumber,
        type: classifyMasterRepairType(row.workType),
        dueDate: getYearlyDueDate([{ visitDate }]),
        scheduledAppointment: null,
        ccm: ccmId,
        ccmId,
        status: callListEntry.status,
        assigneeId: callListEntry.ownerUserId,
        assigneeName: null,
        importedDetails: { ...row, ccmId },
        workshopVisits: [{
          repairOrderNo: roNumber,
          visitDate,
          closingDate,
          gpDate,
          totalLaborCost: laborCost,
          totalPartsCost: partsCost,
          totalAmount: laborCost == null && partsCost == null ? null : (laborCost || 0) + (partsCost || 0),
          importedDetails: { ...row, ccmId },
        }],
      };
    });
    return res.status(201).json({ record });
  } catch (error) {
    if (error?.code === 'P2002' || error?.code === 'IDENTITY_CONFLICT') {
      return res.status(409).json({ message: error.message || 'This VIN, registration number, or repair order already exists.' });
    }
    throw error;
  }
}

function customerReadScope(user) {
  const role = normalizeRole(user?.role);
  const where = role === 'ADMIN' || role === 'GM'
    ? {}
    : role === 'CCM'
      ? {
        OR: [
          { ccmId: user?.ccmId || 'no-access' },
          { vehicles: { some: { ccmId: user?.ccmId || 'no-access' } } },
        ],
      }
      : role === 'CRE'
        ? creCustomerWhere(user)
        : { id: 'no-access' };
  const allocationWhere = role === 'ADMIN' || role === 'GM'
    ? {}
    : role === 'CCM'
      ? { ccmId: user?.ccmId || 'no-access' }
      : role === 'CRE'
        ? { ccmId: user?.ccmId || 'no-access', creId: user?.id || 'no-access', status: 'assigned' }
        : { id: 'no-access' };
  return { role, where, allocationWhere };
}

function createCustomerBatchLoader(user) {
  const { role, where, allocationWhere } = customerReadScope(user);
  const loadCustomerBatch = (ids) => prisma.customer.findMany({
    where: { AND: [where, { id: { in: ids } }] },
    include: {
      vehicles: {
        ...(role === 'CCM'
          ? { where: { ccmId: user?.ccmId || 'no-access' } }
          : role === 'CRE'
            ? { where: creVehicleWhere(user) }
            : {}),
        include: {
          physicalVehicle: {
            include: {
              workshopVisits: {
                where: workshopVisitVisibilityWhere(user),
                orderBy: latestWorkshopVisitOrderBy,
                select: {
                  id: true,
                  vehicleId: true,
                  repairOrderNo: true,
                  ccmId: true,
                  visitDate: true,
                  createdAt: true,
                  closingDate: true,
                  gpDate: true,
                  totalAmount: true,
                  importedDetails: true,
                },
              },
            },
          },
          allocations: {
            where: allocationWhere,
            include: {
              cre: { select: { id: true, name: true, username: true } },
            },
          },
        },
      },
      visits: {
        where: workshopVisitVisibilityWhere(user),
        orderBy: latestWorkshopVisitOrderBy,
        select: {
          id: true,
          vehicleId: true,
          repairOrderNo: true,
          ccmId: true,
          visitDate: true,
          closingDate: true,
          gpDate: true,
          totalAmount: true,
          importedDetails: true,
        },
      },
    },
  });
  // Ordered relation loads are not chunked by Prisma, so a batch whose vehicles exceed the
  // bind-parameter limit is split in half and retried instead of failing the request.
  const loadCustomerBatchSafely = async (ids) => {
    try {
      return await loadCustomerBatch(ids);
    } catch (error) {
      if (error?.code !== 'P2029' || ids.length < 2) throw error;
      const middle = Math.ceil(ids.length / 2);
      return [
        ...await loadCustomerBatchSafely(ids.slice(0, middle)),
        ...await loadCustomerBatchSafely(ids.slice(middle)),
      ];
    }
  };
  return async (idChunk) => {
    const batch = await loadCustomerBatchSafely(idChunk);
    const position = new Map(idChunk.map((id, index) => [id, index]));
    return batch.sort((left, right) => position.get(left.id) - position.get(right.id));
  };
}

const SLIM_VISIT_FIELDS = ['id', 'vehicleId', 'repairOrderNo', 'ccmId', 'visitDate', 'createdAt', 'closingDate', 'gpDate', 'totalAmount'];

function slimVisit(visit) {
  return Object.fromEntries(SLIM_VISIT_FIELDS.map((field) => [field, visit[field]]));
}

// `detail` keeps the full repair-order history (importedDetails, dealer codes) for one customer;
// the list form drops it so large customer lists stay small in memory and on the wire.
async function serializeCustomerBatch(rows, { detail }) {
  const now = new Date();
  const historyVisits = detail
    ? rows.flatMap((customer) => [
      ...(customer.visits || []),
      ...(customer.vehicles || []).flatMap((vehicle) => vehicle.physicalVehicle?.workshopVisits || []),
    ])
    : [];
  const visitsWithDealerCodes = await addOriginatingDealerCodes(historyVisits);
  const dealerCodeByVisitId = new Map(visitsWithDealerCodes.map((visit) => [visit.id, visit]));

  return rows.map((customer) => {
      const allVisits = new Map((customer.visits || []).map((visit) => [
        visit.id,
        dealerCodeByVisitId.get(visit.id) || { ...visit, dealerCode: null },
      ]));
      for (const vehicle of customer.vehicles || []) {
        for (const visit of vehicle.physicalVehicle?.workshopVisits || []) {
          allVisits.set(visit.id, {
            ...(dealerCodeByVisitId.get(visit.id) || { ...visit, dealerCode: null }),
            vehicleId: vehicle.id,
          });
        }
      }
      const visits = [...allVisits.values()].sort((left, right) => {
        const dateDifference = (right.visitDate ? new Date(right.visitDate).getTime() : Number.NEGATIVE_INFINITY)
          - (left.visitDate ? new Date(left.visitDate).getTime() : Number.NEGATIVE_INFINITY);
        if (dateDifference) return dateDifference;
        const createdDifference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        return createdDifference || String(right.id).localeCompare(String(left.id));
      });
      return {
        id: customer.id,
        name: customer.fullName,
        customerName: customer.fullName,
        mobile: usableMobileNumber(customer.mobileNumber) || importedMobileNumber(visits),
        ccmId: customer.ccmId,
        email: customer.email,
        address: customer.address || importedCustomerDetail(visits, ['address', 'addressLine', 'customerAddress']),
        city: customer.city || importedCustomerDetail(visits, ['city', 'customerCity']),
        pin: customer.pin || importedCustomerDetail(visits, ['pin', 'pinCode', 'customerPin']),
        vehicleCount: customer.vehicles?.length || 0,
        vehicles: (customer.vehicles || []).map(({ physicalVehicle, ...vehicle }) => ({
          ...vehicle,
          vehicleAgeMonths: getAgeInMonths(vehicle.saleDate, now),
          ...(detail ? {
            workshopVisits: (physicalVehicle?.workshopVisits || [])
              .map((visit) => dealerCodeByVisitId.get(visit.id) || { ...visit, dealerCode: null }),
          } : {}),
          freeServicesRemaining: countRemainingFreeServiceMilestones({
            saleDate: vehicle.saleDate,
            workshopVisits: physicalVehicle?.workshopVisits || [],
          }, now),
        })),
        visits: detail ? visits : visits.map(slimVisit),
      };
  });
}

function customersForbidden(req, res) {
  if (normalizeRole(req.user?.role) !== 'FREE_SERVICE_CRE') return false;
  res.status(403).json({ message: 'Customer records are not available to the Free-Service CRE role.' });
  return true;
}

export async function getCustomers(req, res) {
  if (customersForbidden(req, res)) return undefined;
  const query = req.query || {};
  const pagination = Object.hasOwn(query, 'limit') || Object.hasOwn(query, 'offset') ? parsePagination(query) : null;
  if (pagination?.error) return res.status(400).json({ message: pagination.error });

  const logMemory = createCustomerMemoryLogger();
  logMemory('start');
  const { where } = customerReadScope(req.user);
  const loadBatch = createCustomerBatchLoader(req.user);
  const allIds = [...new Set((await prisma.customer.findMany({
    where,
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  })).map((customer) => customer.id))];
  const pageIds = pagination ? allIds.slice(pagination.offset, pagination.offset + pagination.limit) : allIds;
  logMemory('ids-loaded', { totalIds: allIds.length, pageIds: pageIds.length });

  const customers = [];
  let batchNumber = 0;
  for (const idChunk of splitIntoChunks(pageIds, CUSTOMER_QUERY_BATCH_SIZE)) {
    customers.push(...await serializeCustomerBatch(await loadBatch(idChunk), { detail: false }));
    batchNumber += 1;
    logMemory('batch-done', { batch: batchNumber, customers: customers.length });
  }
  logMemory('response-ready', { customers: customers.length });
  return res.json({
    customers,
    ...(pagination ? {
      total: allIds.length,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: pagination.offset + pageIds.length < allIds.length,
    } : {}),
  });
}

export async function getCustomerById(req, res) {
  if (customersForbidden(req, res)) return undefined;
  const rows = await createCustomerBatchLoader(req.user)([String(req.params?.id || '')]);
  if (!rows.length) return res.status(404).json({ message: 'Customer not found.' });
  const [customer] = await serializeCustomerBatch(rows, { detail: true });
  return res.json({ customer });
}

export async function getAppointments(req, res) {
  const rows = await prisma.appointment.findMany({
    where: appointmentVisibilityWhere(req.user),
    include: {
      customer: { select: { id: true, fullName: true } },
      vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
      assignee: { select: { id: true, name: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  return res.json({
    appointments: rows.map((appointment) => ({
      id: appointment.id,
      customer: appointment.customer?.fullName || appointment.customerName,
      customerId: appointment.customerId,
      vehicle: appointment.vehicle?.model || appointment.vehicleName,
      vehicleId: appointment.vehicleId,
      scheduledAt: appointment.scheduledAt,
      time: new Date(appointment.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: new Date(appointment.scheduledAt).toISOString().slice(0, 10),
      status: appointment.status,
      confirmationCall: appointment.confirmationCall,
      ccmId: appointment.ccmId,
      assigneeId: appointment.assigneeId,
      assigneeName: appointment.assignee?.name || appointment.assigneeNameSnapshot || null,
    })),
  });
}
