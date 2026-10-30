import { prisma } from '../config/prisma.js';
import { creCustomerWhere, isVehicleAssignedToCre } from '../utils/creAccess.js';
import { canAccessRecord } from '../utils/roleAccess.js';
import { validateCallLogPayload, validateFollowUpPayload } from '../utils/workflowRules.js';
import { getCreCallCounts } from '../utils/callMetrics.js';
import { DAILY_TARGETS, freeServiceCustomerIdsForMonth, isAnsweredOutcome } from '../utils/serviceCalendar.js';
import { findMissedWarrantyCases } from '../utils/serviceLists.js';
import { parseDateKey, workshopDayRange, workshopMonthOf, workshopMonthRange, zonedDateKey } from '../utils/workshopTime.js';
import { allowedServiceSources, canAccessServiceSource } from '../utils/creServicePermissions.js';
import { appointmentVisibilityWhere } from '../utils/appointmentAccess.js';
import { appointmentConversionRatePercent } from '../utils/performanceMetrics.js';
import { classifyDueCohorts, countOverdueRecords, creDueWhere, loadCallListRecords } from './recordsController.js';

function normalizeRole(role) {
  const value = String(role || '').toUpperCase();
  if (value === 'ADMIN') return 'Admin';
  if (value === 'GM') return 'GM';
  if (value === 'CCM') return 'CCM';
  if (value === 'FREE_SERVICE_CRE' || value === 'FREE-SERVICE CRE') return 'FREE_SERVICE_CRE';
  return 'CRE';
}

function userForAccess(user) {
  return { ...user, role: normalizeRole(user?.role) };
}

async function findAccessibleCustomer(customerId, user) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      vehicles: {
        include: { allocations: true, masterCallListEntries: true },
      },
    },
  });

  if (!customer || !canAccessRecord(userForAccess(user), customer)) {
    return null;
  }

  if (normalizeRole(user?.role) === 'CRE') {
    const assignedToCre = customer.vehicles.some((vehicle) => isVehicleAssignedToCre(vehicle, user));
    if (!assignedToCre) return null;
  }

  return customer;
}

export function callLogVisibility(user, customerId = '') {
  const role = normalizeRole(user?.role);
  let visibility;
  if (role === 'Admin' || role === 'GM') visibility = {};
  else if (role === 'CCM') {
    visibility = { customer: { is: { OR: [{ ccmId: user.ccmId }, { ccmId: null }] } } };
  } else {
    visibility = {
      assignedToId: user.id,
      customer: { is: creCustomerWhere(user) },
      callSource: { in: allowedServiceSources(user) },
    };
  }

  return { ...visibility, ...(customerId ? { customerId } : {}) };
}

function followUpVisibility(user) {
  const role = normalizeRole(user?.role);
  if (role === 'Admin' || role === 'GM') return {};
  if (role === 'CCM') {
    return { customer: { is: { OR: [{ ccmId: user.ccmId }, { ccmId: null }] } } };
  }

  return {
    customer: { is: creCustomerWhere(user) },
    source: { in: allowedServiceSources(user) },
  };
}

export async function listCallLogs(req, res) {
  const customerId = String(req.query?.customerId || '').trim();
  const callLogs = await prisma.callLog.findMany({
    where: callLogVisibility(req.user, customerId),
    include: {
      customer: { select: { id: true, fullName: true, mobileNumber: true } },
      vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
      creator: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(!customerId ? { take: 200 } : {}),
  });

  return res.json({ callLogs });
}

export async function getFreeServicePerformanceSummary(req, res) {
  const role = normalizeRole(req.user?.role);
  if (role !== 'FREE_SERVICE_CRE' && role !== 'CCM') {
    return res.status(403).json({ message: 'Not permitted.' });
  }

  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return res.status(400).json({ message: 'A valid year and month are required.' });
  }
  const performanceDateKey = String(req.query.date || workshopDayRange().dateKey);
  const requestedDay = parseDateKey(performanceDateKey);
  if (!requestedDay || performanceDateKey > workshopDayRange().dateKey) {
    return res.status(400).json({ message: 'date must be a valid workshop date no later than today.' });
  }

  let target;
  if (role === 'CCM') {
    const userId = String(req.query.creId || '').trim();
    if (!userId) return res.status(400).json({ message: 'creId is required for a CCM to view performance.' });
    target = await prisma.user.findFirst({
      where: { id: userId, role: 'FREE_SERVICE_CRE', ccmId: req.user.ccmId },
      select: { id: true, name: true },
    });
    if (!target) return res.status(404).json({ message: 'Free-Service CRE not found in your team.' });
  } else {
    target = { id: req.user.id, name: req.user.name };
  }

  const { start, end } = workshopMonthRange(year, month);
  const calls = await prisma.callLog.findMany({
    where: {
      createdById: target.id,
      callSource: 'FREE_SERVICE',
      createdAt: { gte: start, lt: end },
    },
    select: { outcome: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const dailyRows = new Map();
  for (const call of calls) {
    const date = zonedDateKey(call.createdAt);
    const row = dailyRows.get(date) || { date, callsMade: 0, callsPickedUp: 0 };
    row.callsMade += 1;
    if (isAnsweredOutcome(call.outcome)) row.callsPickedUp += 1;
    dailyRows.set(date, row);
  }

  const selectedDayCounts = await getCreCallCounts({
    creIds: [target.id],
    start: requestedDay.start,
    end: requestedDay.end,
    callSources: ['FREE_SERVICE'],
  });
  const selectedDay = selectedDayCounts.get(target.id) || { callsMade: 0, callsPickedUp: 0 };
  return res.json({
    user: { id: target.id, name: target.name, role: 'FREE_SERVICE_CRE' },
    performanceDate: performanceDateKey,
    dailyTargets: {
      callsMade: { actual: selectedDay.callsMade, target: DAILY_TARGETS.callsMade },
      callsPickedUp: { actual: selectedDay.callsPickedUp, target: DAILY_TARGETS.callsPickedUp },
    },
    callsThisMonth: calls.length,
    dailyPerformance: [...dailyRows.values()],
  });
}

export async function getCrePerformanceSummary(req, res) {
  const role = normalizeRole(req.user?.role);
  if (role !== 'CRE' && role !== 'CCM') return res.status(403).json({ message: 'Not permitted.' });

  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return res.status(400).json({ message: 'A valid year and month are required.' });
  }
  const performanceDateKey = String(req.query.date || workshopDayRange().dateKey);
  const requestedDay = parseDateKey(performanceDateKey);
  if (!requestedDay || performanceDateKey > workshopDayRange().dateKey) {
    return res.status(400).json({ message: 'date must be a valid workshop date no later than today.' });
  }

  let targetCre;
  if (role === 'CCM') {
    const creId = String(req.query.creId || '').trim();
    if (!creId) return res.status(400).json({ message: 'creId is required for a CCM to view a CRE\'s performance.' });
    targetCre = await prisma.user.findFirst({
      where: { id: creId, role: 'CRE', ccmId: req.user.ccmId },
      select: { id: true, name: true, ccmId: true },
    });
    if (!targetCre) return res.status(404).json({ message: 'CRE not found in your team.' });
  } else {
    targetCre = { id: req.user.id, name: req.user.name, ccmId: req.user.ccmId };
  }
  // Reuses the CRE-shaped visibility helpers for whichever CRE is being viewed, whether that is
  // the signed-in CRE or, for a CCM, one of their team members.
  const targetUser = {
    id: targetCre.id,
    role: 'CRE',
    ccmId: targetCre.ccmId,
    freeServiceEnabled: role === 'CCM' || targetCre.freeServiceEnabled === true,
    warrantyEnabled: role === 'CCM' || targetCre.warrantyEnabled === true,
  };

  const now = new Date();
  const { start: monthStart, end: monthEnd } = workshopMonthRange(year, month);
  const current = workshopMonthOf(now);
  const isCurrentMonth = current.year === year && current.month === month;
  // Historical months are classified using only the service history that existed by their end,
  // so a past month's figures never change if a later repair order is imported today.
  const asOf = isCurrentMonth ? now : new Date(monthEnd.getTime() - 1);

  const latestMonthlyImport = await prisma.monthlyCustomerDataImport.findFirst({
    where: {
      status: 'completed',
      addedRows: { gt: 0 },
      dataset: { is: { ccmId: targetCre.ccmId, year, month } },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const cycleStart = latestMonthlyImport && latestMonthlyImport.createdAt > monthStart ? latestMonthlyImport.createdAt : monthStart;

  const callVisibility = callLogVisibility(targetUser);
  const followUpVisibilityFilter = followUpVisibility(targetUser);
  // Warranty calls are separate from ordinary activity; CRE metrics honor category access.
  const ordinaryCallSources = allowedServiceSources(targetUser).filter((source) => source !== 'WARRANTY');
  const monthFilter = {
    ...callVisibility,
    callSource: { in: ordinaryCallSources },
    createdAt: { gte: cycleStart, lt: monthEnd },
  };
  const dueWhere = creDueWhere(targetCre.id, targetCre.ccmId);

  const [callsThisMonth, customersReachedThisMonth, scopedRecords, pendingFollowUps, appointmentsSetThisMonth, recentCalls, dailyCounts, missedWarrantyCases, lifetimeCalls, lifetimeAppointments] = await Promise.all([
    prisma.callLog.count({ where: monthFilter }),
    prisma.callLog.groupBy({ by: ['customerId'], where: monthFilter }),
    loadCallListRecords(dueWhere, now),
    prisma.followUp.count({ where: { ...followUpVisibilityFilter, status: 'pending' } }),
    prisma.callLog.count({ where: { ...monthFilter, outcome: 'APPOINTMENT_SET' } }),
    prisma.callLog.findMany({
      where: {
        ...callVisibility,
        callSource: { in: ordinaryCallSources },
        createdAt: { gte: requestedDay.start, lt: requestedDay.end },
      },
      include: {
        customer: { select: { id: true, fullName: true, mobileNumber: true } },
        vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 6,
    }),
    getCreCallCounts({
      creIds: [targetCre.id],
      start: requestedDay.start,
      end: requestedDay.end,
      callSources: ordinaryCallSources,
    }),
    canAccessServiceSource(targetUser, 'WARRANTY')
      ? findMissedWarrantyCases({ scope: dueWhere, year, month, now })
      : Promise.resolve([]),
    prisma.callLog.count({ where: { createdById: targetCre.id } }),
    // Count each persisted appointment row once, including cancelled appointments. Deleted rows
    // are intentionally absent, matching the appointment system's existing hard-delete behavior.
    prisma.appointment.count({ where: appointmentVisibilityWhere(targetUser) }),
  ]);

  // Assigned workload is the unique customers across the month's 1-Year Due, 6-Month Due and Free Service
  // lists. Warranty customers are excluded, and repeat calls to one customer never inflate it.
  const cohorts = classifyDueCohorts(scopedRecords, asOf);
  const freeServiceIds = canAccessServiceSource(targetUser, 'FREE_SERVICE')
    ? freeServiceCustomerIdsForMonth(scopedRecords, year, month, asOf)
    : new Set();
  const workloadCustomerIds = new Set([
    ...cohorts.oneYear.map((record) => record.customerId),
    ...cohorts.sixMonth.map((record) => record.customerId),
    ...freeServiceIds,
  ].filter(Boolean));
  const assignedCustomerCount = workloadCustomerIds.size;
  const dueServicesCount = countOverdueRecords(scopedRecords, now);
  const dayCounts = dailyCounts.get(targetCre.id) || { callsMade: 0, callsPickedUp: 0 };

  return res.json({
    cre: { id: targetCre.id, name: targetCre.name },
    period: { year, month, isCurrentMonth },
    performanceDate: performanceDateKey,
    callsToday: dayCounts.callsMade,
    dailyTargets: {
      callsMade: { actual: dayCounts.callsMade, target: DAILY_TARGETS.callsMade },
      callsPickedUp: { actual: dayCounts.callsPickedUp, target: DAILY_TARGETS.callsPickedUp },
    },
    callsThisMonth,
    lifetimeCalls,
    lifetimeAppointments,
    appointmentConversionRatePercent: appointmentConversionRatePercent(lifetimeAppointments, lifetimeCalls),
    customersReachedThisMonth: customersReachedThisMonth.length,
    assignedCustomerCount,
    assignedBreakdown: {
      oneYear: new Set(cohorts.oneYear.map((record) => record.customerId)).size,
      sixMonth: new Set(cohorts.sixMonth.map((record) => record.customerId)).size,
      freeService: canAccessServiceSource(targetUser, 'FREE_SERVICE') ? freeServiceIds.size : null,
    },
    customerReachPercent: assignedCustomerCount
      ? Math.min(100, Math.round((customersReachedThisMonth.length / assignedCustomerCount) * 100))
      : 0,
    pendingFollowUps,
    appointmentsSetThisMonth,
    dueServicesCount,
    missedWarrantyCount: canAccessServiceSource(targetUser, 'WARRANTY') ? missedWarrantyCases.length : null,
    cycleStartedAt: cycleStart,
    recentCalls,
  });
}

export async function createCallLog(req, res) {
  const validation = validateCallLogPayload(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const { customerId, vehicleId, outcome, callSource, milestoneId, notes, followUpAt } = validation.value;
  if (!canAccessServiceSource(req.user, callSource)) {
    return res.status(403).json({ message: 'You do not have permission to log calls for this service category.' });
  }
  const customer = await findAccessibleCustomer(customerId, req.user);
  if (!customer) return res.status(404).json({ message: 'Customer not found.' });

  if (vehicleId) {
    const vehicle = customer.vehicles.find((entry) => entry.id === vehicleId);
    if (!vehicle) return res.status(400).json({ message: 'Vehicle does not belong to this customer.' });
    if (normalizeRole(req.user.role) === 'CRE' && !isVehicleAssignedToCre(vehicle, req.user)) {
      return res.status(404).json({ message: 'Customer not found.' });
    }
  }

  if (milestoneId) {
    const milestone = await prisma.freeServiceMilestone.findUnique({ where: { id: milestoneId }, select: { vehicleId: true } });
    if (!milestone || milestone.vehicleId !== vehicleId) {
      return res.status(400).json({ message: 'Free-service milestone does not belong to this vehicle.' });
    }
  }

  const creId = normalizeRole(req.user.role) === 'CRE' ? req.user.id : null;

  const result = await prisma.$transaction(async (transaction) => {
    const callLog = await transaction.callLog.create({
      data: {
        customerId,
        vehicleId,
        outcome,
        callSource,
        milestoneId,
        notes,
        followUpAt,
        createdById: req.user.id,
        assignedToId: creId,
      },
      include: {
        customer: { select: { id: true, fullName: true, mobileNumber: true } },
        vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
      },
    });

    // Follow-ups are isolated per list (Service, Free Service, Warranty). A new call settles this
    // customer's open follow-up in the same list: it is rescheduled in place when the call sets a new
    // date, and otherwise completed so the customer leaves the queue. Other lists are untouched.
    const openWhere = {
      customerId,
      source: callSource,
      status: 'pending',
      ...(milestoneId ? { milestoneId } : {}),
      ...(vehicleId ? { OR: [{ vehicleId }, { vehicleId: null }] } : {}),
    };
    const open = await transaction.followUp.findMany({ where: openWhere, orderBy: { createdAt: 'asc' } });

    let followUp = null;
    if (followUpAt) {
      const data = { followUpAt, category: outcome, notes, vehicleId, creId, milestoneId };
      if (open.length) {
        followUp = await transaction.followUp.update({ where: { id: open[0].id }, data });
        const duplicates = open.slice(1).map((entry) => entry.id);
        if (duplicates.length) await transaction.followUp.updateMany({ where: { id: { in: duplicates } }, data: { status: 'completed' } });
      } else {
        followUp = await transaction.followUp.create({ data: { customerId, source: callSource, ...data } });
      }
    } else if (open.length) {
      await transaction.followUp.updateMany({ where: { id: { in: open.map((entry) => entry.id) } }, data: { status: 'completed' } });
    }

    return { callLog, followUp };
  });

  return res.status(201).json(result);
}

const FOLLOW_UP_INCLUDE = {
  customer: { select: { id: true, fullName: true, mobileNumber: true } },
  vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
  cre: { select: { id: true, name: true } },
  milestone: { select: { id: true, milestone: true, dueDate: true } },
};

export async function listFollowUps(req, res) {
  const source = req.query.source ? String(req.query.source).trim().toUpperCase() : null;
  if (source && !['SERVICE', 'FREE_SERVICE', 'WARRANTY'].includes(source)) {
    return res.status(400).json({ message: 'Follow-up source is invalid.' });
  }
  if (source && !canAccessServiceSource(req.user, source)) {
    return res.status(403).json({ message: 'You do not have permission to access this follow-up category.' });
  }

  const followUps = await prisma.followUp.findMany({
    where: {
      ...followUpVisibility(req.user),
      status: 'pending',
      ...(source ? { source } : {}),
      ...(!source && normalizeRole(req.user.role) === 'CRE' ? { source: { in: allowedServiceSources(req.user) } } : {}),
    },
    include: FOLLOW_UP_INCLUDE,
    orderBy: { followUpAt: 'asc' },
    take: 200,
  });

  return res.json({ followUps });
}

export async function createFollowUp(req, res) {
  const validation = validateFollowUpPayload(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const { customerId, category, notes, followUpAt, source, vehicleId, milestoneId } = validation.value;
  if (!canAccessServiceSource(req.user, source)) {
    return res.status(403).json({ message: 'You do not have permission to create follow-ups for this service category.' });
  }
  const customer = await findAccessibleCustomer(customerId, req.user);
  if (!customer) return res.status(404).json({ message: 'Customer not found.' });
  if (vehicleId && !customer.vehicles.some((vehicle) => vehicle.id === vehicleId)) {
    return res.status(400).json({ message: 'Vehicle does not belong to this customer.' });
  }

  const followUp = await prisma.followUp.create({
    data: {
      customerId,
      category,
      notes,
      followUpAt,
      source,
      vehicleId,
      milestoneId,
      creId: normalizeRole(req.user.role) === 'CRE' ? req.user.id : null,
    },
    include: FOLLOW_UP_INCLUDE,
  });

  return res.status(201).json({ followUp });
}

export async function updateFollowUpStatus(req, res) {
  const status = String(req.body?.status || '').trim().toLowerCase();
  if (!['pending', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ message: 'Status must be pending, completed, or cancelled.' });
  }

  const existing = await prisma.followUp.findFirst({
    where: { id: req.params.id, ...followUpVisibility(req.user) },
  });
  if (!existing) return res.status(404).json({ message: 'Follow-up not found.' });

  const followUp = await prisma.followUp.update({
    where: { id: existing.id },
    data: { status },
  });

  return res.json({ followUp });
}