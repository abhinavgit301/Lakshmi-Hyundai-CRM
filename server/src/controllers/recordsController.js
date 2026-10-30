import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { appointmentVisibilityWhere } from '../utils/appointmentAccess.js';
import { evaluateRepairOrderRow } from '../utils/businessRules.js';
import { creCustomerWhere } from '../utils/creAccess.js';
import { buildDuplicateKey, normalizeVin } from '../utils/roleAccess.js';
import { addMonths, classifyServiceDue, getLatestServiceDate, getYearlyDueDate, parseStoredDate } from '../utils/serviceDue.js';
import {
  normalizeSaleDate,
  DAILY_TARGETS,
  freeServiceCustomerIdsForMonth,
  buildQuotaRows,
  buildQuotaNotifications,
} from '../utils/serviceCalendar.js';
import { workshopDayRange, workshopMonthOf } from '../utils/workshopTime.js';
import { getCreCallCounts } from '../utils/callMetrics.js';
import { findMissedWarrantyCases } from '../utils/serviceLists.js';
import { lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { allowedServiceSources, canAccessServiceSource } from '../utils/creServicePermissions.js';
import { classifyMasterRepairType } from '../utils/repairTypes.js';
import { filterMasterCallListRecords, validateMasterCallListFilters } from '../utils/masterCallListFilters.js';

function normalizeRole(role) {
  return String(role || '').toUpperCase();
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

export async function getDashboardSummary(req, res) {
  const user = req.user;
  const role = normalizeRole(user?.role);
  const now = new Date();
  const dayRange = workshopDayRange(now);
  const monthInfo = workshopMonthOf(now);
  if (role === 'FREE_SERVICE_CRE') {
    const counts = await getCreCallCounts({
      creIds: [user.id],
      start: dayRange.start,
      end: dayRange.end,
      callSources: ['FREE_SERVICE'],
    });
    const activity = counts.get(user.id) || { callsMade: 0, callsPickedUp: 0 };
    const appointments = await prisma.appointment.findMany({
      where: {
        createdById: user.id,
        customerId: null,
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
    prisma.customer.count(),
    prisma.vehicle.count({ where: { status: 'ACTIVE' } }),
    prisma.callLog.count({
      where: {
        createdAt: {
          gte: dayRange.start,
          lt: dayRange.end,
        },
      },
    }),
    prisma.appointment.count({
      where: {
        scheduledAt: {
          gte: dayRange.start,
          lt: dayRange.end,
        },
      },
    }),
    prisma.followUp.count({ where: { status: 'pending' } }),
    prisma.callLog.count(),
    prisma.callLog.count({ where: { outcome: 'APPOINTMENT_SET' } }),
    prisma.importBatch.aggregate({ _sum: { totalRows: true, flaggedRows: true } }),
    prisma.vINConflictReview.count({ where: { status: 'pending' } }),
    prisma.allocation.count({ where: { status: 'assigned' } }),
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
      loadCallListRecords(dueWhere, now),
      getCreCallCounts({
        creIds: [user.id],
        start: dayRange.start,
        end: dayRange.end,
        callSources: allowedServiceSources(user).filter((source) => source !== 'WARRANTY'),
      }),
      prisma.followUp.findMany({
        where: {
          status: 'pending',
          customer: { is: creCustomerWhere(user) },
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
        ? findMissedWarrantyCases({ scope: dueWhere, year: monthInfo.year, month: monthInfo.month, now })
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
        where: { ccmId, scheduledAt: { gte: dayRange.start, lt: dayRange.end } },
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
      prisma.followUp.count({ where: { status: 'pending', customer: { is: { ccmId } } } }),
    ]);

    const creIds = cres.map((c) => c.id);
    const prevDayRange = workshopDayRange(now, -1);
    const [todayCounts, prevCounts] = await Promise.all([
      getCreCallCounts({ creIds, start: dayRange.start, end: dayRange.end }),
      getCreCallCounts({ creIds, start: prevDayRange.start, end: prevDayRange.end }),
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

export async function loadCallListRecords(where, now = new Date()) {
  const upcomingAppointmentWhere = {
    scheduledAt: { gte: now },
    status: { in: ['PENDING', 'CONFIRMED', 'RESCHEDULED'] },
  };
  const rows = await prisma.masterCallList.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      vehicle: {
        include: {
          workshopVisits: {
            orderBy: { createdAt: 'desc' },
            select: {
              repairOrderNo: true,
              visitDate: true,
              closingDate: true,
              gpDate: true,
              totalLaborCost: true,
              totalPartsCost: true,
              totalAmount: true,
              importedDetails: true,
            },
          },
          allocations: {
            where: { status: 'assigned' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { serviceType: true },
          },
          monthlyDataEntries: {
            where: {
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
            where: upcomingAppointmentWhere,
            orderBy: { scheduledAt: 'asc' },
            take: 1,
            select: { id: true, scheduledAt: true, status: true },
          },
          customer: {
            include: {
              appointments: {
                where: { ...upcomingAppointmentWhere, vehicleId: null },
                orderBy: { scheduledAt: 'asc' },
                take: 1,
                select: { id: true, scheduledAt: true, status: true },
              },
            },
          },
        },
      },
    },
  });
  const ownerIds = [...new Set(rows.map((row) => row.ownerUserId).filter(Boolean))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, name: true },
    })
    : [];
  const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));

  return rows.map((row) => ({
      id: row.id,
      customerId: row.vehicle?.customerId || null,
      vehicleId: row.vehicle?.id || null,
      name: row.customerName,
      customerName: row.customerName,
      vin: row.vin,
      mobile: row.mobileNumber,
      model: row.vehicle?.model || null,
      vehicleAgeMonths: getAgeInMonths(
        row.vehicle?.saleDate
          || (row.vehicle?.workshopVisits || [])
            .map((visit) => parseStoredDate(visit.importedDetails?.saleDate))
            .find(Boolean),
        now,
      ),
      registrationNumber: row.registrationNumber || row.vehicle?.registrationNumber || null,
      saleDate: row.vehicle?.saleDate || null,
      type: classifyMasterRepairType(row.vehicle?.workshopVisits[0]?.importedDetails?.workType
        || row.vehicle?.monthlyDataEntries[0]?.serviceType
        || row.vehicle?.allocations[0]?.serviceType),
      dueCategory: classifyServiceDue(
        getLatestServiceDate(row.vehicle?.workshopVisits || [], now),
        now,
      ),
      dueDate: getYearlyDueDate(row.vehicle?.workshopVisits || [])
        || row.vehicle?.monthlyDataEntries[0]?.nextServiceDueDate
        || null,
      scheduledAppointment: [
        ...(row.vehicle?.appointments || []),
        ...(row.vehicle?.customer?.appointments || []),
      ].sort((left, right) => left.scheduledAt - right.scheduledAt)[0] || null,
      ccm: row.ccmId || 'Unassigned',
      status: row.status,
      assigneeId: row.ownerUserId,
      assigneeName: ownerNames.get(row.ownerUserId) || null,
      ccmId: row.ccmId,
      importedDetails: row.vehicle?.workshopVisits[0]?.importedDetails || null,
      workshopVisits: row.vehicle?.workshopVisits || [],
    }));
}

export async function getCallList(req, res) {
  if (normalizeRole(req.user?.role) === 'FREE_SERVICE_CRE') {
    return res.status(403).json({ message: 'Free-Service CRE accounts cannot access the Master Call List.' });
  }
  const validated = validateMasterCallListFilters(req.query);
  if (validated.error) return res.status(400).json({ message: validated.error });
  const records = await loadCallListRecords(getVisibilityWhere(req.user));
  return res.json({
    records: filterMasterCallListRecords(records, validated.filters, req.user?.role),
  });
}

// The MasterCallList scope for one CRE's own due-list and performance figures: vehicles they
// directly own on the master list, or that are actively allocated to them.
export function creDueWhere(creId, ccmId) {
  return {
    ccmId: ccmId || 'no-access',
    OR: [
      { ownerUserId: creId || 'no-access' },
      { vehicle: { is: { allocations: { some: { creId: creId || 'no-access', status: 'assigned' } } } } },
    ],
  };
}

// Classifies loaded records into a due cohort ('1y' or '6m') as of `asOf`, so the same logic can
// recompute a past month's cohort for performance history, not just "right now".
export async function loadDueRecords(where, dueWindow, asOf = new Date()) {
  const cohorts = await loadDueCohorts(where, asOf);
  return dueWindow === '1y' ? cohorts.oneYear : cohorts.sixMonth;
}

// Both cohorts from a single load of the master call list.
export async function loadDueCohorts(where, asOf = new Date()) {
  return classifyDueCohorts(await loadCallListRecords(where, asOf), asOf);
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
    .sort((left, right) => left.dueDate - right.dueDate);
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

  const role = normalizeRole(req.user?.role);
  const where = role === 'CCM'
    ? { ccmId: req.user?.ccmId || 'no-access' }
    : creDueWhere(req.user?.id, req.user?.ccmId);
  const due = await loadDueRecords(where, dueWindow);
  return res.json({ records: due });
}

export async function updateCallListAssignee(req, res) {
  const entry = await prisma.masterCallList.findFirst({
    where: { id: req.params.id, ccmId: req.user.ccmId || 'no-access', ownerUserId: { not: null } },
    select: { id: true, ccmId: true, ownerUserId: true, vin: true },
  });
  if (!entry) return res.status(404).json({ message: 'Allocated customer not found.' });

  const assigneeId = req.body?.assigneeId == null || req.body.assigneeId === ''
    ? null
    : String(req.body.assigneeId).trim();
  if (!assigneeId) return res.status(400).json({ message: 'Choose an active CRE assigned to your team.' });

  const updated = await prisma.$transaction(async (transaction) => {
    await lockCcmAllocationTeam(transaction, entry.ccmId);
    const currentEntry = await transaction.masterCallList.findFirst({
      where: { id: entry.id, ccmId: entry.ccmId, ownerUserId: { not: null } },
      select: { id: true, ownerUserId: true, vin: true },
    });
    if (!currentEntry) return null;
    const assignee = await transaction.user.findFirst({
      where: { id: assigneeId, role: 'CRE', status: 'active', ccmId: entry.ccmId },
      select: { id: true, name: true },
    });
    if (!assignee) return null;
    const record = await transaction.masterCallList.update({
      where: { id: currentEntry.id },
      data: { ownerUserId: assignee.id },
    });
    // Active allocations follow the Master Call List owner so the previous CRE loses access.
    const allocationScope = { status: 'assigned', vehicle: { is: { vin: currentEntry.vin } }, ccmId: entry.ccmId };
    await transaction.allocation.updateMany({ where: allocationScope, data: { creId: assignee.id } });
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
  const ccmId = role === 'CCM' ? req.user.ccmId : String(row.ccmId || '').trim();
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
    return res.status(400).json({ message: 'An active CCM assignment is required.' });
  }
  const activeCcm = await prisma.user.findFirst({
    where: { role: 'CCM', ccmId, status: 'active' },
    select: { ccmId: true },
  });
  if (!activeCcm) return res.status(400).json({ message: 'CCM assignment is invalid.' });

  const [vehicleOwner, matchingVisits] = await Promise.all([
    prisma.vehicle.findUnique({
      where: { vin },
      select: { ccmId: true, customer: { select: { ccmId: true } } },
    }),
    prisma.workshopVisit.findMany({
      where: { repairOrderNo: roNumber },
      include: { vehicle: { select: { vin: true } } },
    }),
  ]);
  const repairOrder = matchingVisits[0];
  const existingKeys = matchingVisits.map((visit) => buildDuplicateKey(visit.vehicle.vin, visit.repairOrderNo));
  const result = evaluateRepairOrderRow({
    ...row,
    vin,
    roNumber,
    ccmId,
    ownerCcmId: vehicleOwner?.ccmId || vehicleOwner?.customer?.ccmId || null,
  }, existingKeys);
  if (result.status === 'skipped') {
    return res.status(409).json({ message: 'This repair order and VIN are already in the system.' });
  }
  if (result.status === 'rejected') {
    return res.status(400).json({ message: result.reason });
  }
  if (result.status === 'flagged') {
    await prisma.vINConflictReview.create({
      data: {
        vin,
        sourceCcmId: vehicleOwner.ccmId || vehicleOwner.customer?.ccmId,
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
      let vehicle = await transaction.vehicle.findUnique({ where: { vin }, include: { customer: true } });
      let customer = vehicle?.customer;

      if (!customer) {
        customer = await transaction.customer.findFirst({
          where: { mobileNumber, ccmId },
          orderBy: { createdAt: 'asc' },
        });
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
      }

      if (!vehicle) {
        vehicle = await transaction.vehicle.create({
          data: {
            vin,
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
      } else if (!vehicle.saleDate && normalizeSaleDate(saleDate)) {
        vehicle = await transaction.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: normalizeSaleDate(saleDate) }, include: { customer: true } });
      }

      await transaction.workshopVisit.create({
        data: {
          repairOrderNo: roNumber,
          customerId: customer.id,
          vehicleId: vehicle.id,
          ccmId,
          totalLaborCost: laborCost,
          totalPartsCost: partsCost,
          totalAmount: laborCost == null && partsCost == null ? null : (laborCost || 0) + (partsCost || 0),
          visitDate,
          closingDate,
          gpDate,
          importedDetails: row,
        },
      });

      const existingEntry = await transaction.masterCallList.findFirst({ where: { vin, ccmId } });
      const callListEntry = existingEntry
        ? await transaction.masterCallList.update({
          where: { id: existingEntry.id },
          data: { customerName, mobileNumber, registrationNumber: vehicle.registrationNumber },
        })
        : await transaction.masterCallList.create({
          data: {
            customerName,
            mobileNumber,
            vin,
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
        importedDetails: row,
        workshopVisits: [{
          repairOrderNo: roNumber,
          visitDate,
          closingDate,
          gpDate,
          totalLaborCost: laborCost,
          totalPartsCost: partsCost,
          totalAmount: laborCost == null && partsCost == null ? null : (laborCost || 0) + (partsCost || 0),
          importedDetails: row,
        }],
      };
    });
    return res.status(201).json({ record });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ message: 'This VIN, registration number, or repair order already exists.' });
    }
    throw error;
  }
}

export async function getCustomers(req, res) {
  if (normalizeRole(req.user?.role) === 'FREE_SERVICE_CRE') {
    return res.status(403).json({ message: 'Customer records are not available to the Free-Service CRE role.' });
  }
  const user = req.user;
  const role = normalizeRole(user?.role);

  let where = {};

  if (role === 'CCM') {
    where = {
      OR: [{ ccmId: user?.ccmId || null }, { ccmId: null }],
    };
  }

  if (role === 'CRE') {
    where = creCustomerWhere(user);
  }

  const rows = await prisma.customer.findMany({
    where,
    include: {
      vehicles: {
        include: {
          allocations: {
            include: {
              cre: { select: { id: true, name: true, username: true } },
            },
          },
        },
      },
      visits: {
        orderBy: { visitDate: 'desc' },
        select: {
          vehicleId: true,
          repairOrderNo: true,
          visitDate: true,
          closingDate: true,
          gpDate: true,
          totalAmount: true,
          importedDetails: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({
    customers: rows.map((customer) => ({
      id: customer.id,
      name: customer.fullName,
      customerName: customer.fullName,
      mobile: customer.mobileNumber,
      ccmId: customer.ccmId,
      email: customer.email,
      vehicleCount: customer.vehicles?.length || 0,
      vehicles: customer.vehicles || [],
      visits: customer.visits || [],
    })),
  });
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
      assigneeName: appointment.assignee?.name || null,
    })),
  });
}
