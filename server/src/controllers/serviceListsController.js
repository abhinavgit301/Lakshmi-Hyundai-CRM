import { prisma } from '../config/prisma.js';
import {
  classifyWarrantyCase,
  classifyFreeServiceStatus,
  freeServiceCallStart,
  freeServiceExpiryDate,
  freeServiceSaleDateRanges,
  getServiceLifecycle,
  isFreeServiceListVisible,
  isWarrantyCallable,
  resolveSaleDate,
  warrantyCallingWindow,
  warrantyExpiryDate,
  warrantySaleDateRange,
} from '../utils/serviceCalendar.js';
import { filterMilestoneCompletionByVisits, syncFreeServiceMilestones } from '../utils/serviceLists.js';
import { getWorkshopTimezone, workshopToday, zonedDateKey } from '../utils/workshopTime.js';
import { canAccessServiceSource } from '../utils/creServicePermissions.js';
import { creCustomerWhere, creVehicleWhere } from '../utils/creAccess.js';
import { filterServiceListRecords, paginateRecords, parsePagination } from '../utils/pagination.js';
import { withCachedResponse } from '../utils/callListCache.js';
import { readByIdBatches } from '../utils/readByIdBatches.js';
import { creDueWhere, loadCallListRecords } from './recordsController.js';

function scopeFor(user) {
  return String(user?.role || '').toUpperCase() === 'CCM'
    ? { ccmId: user?.ccmId || 'no-access' }
    : creDueWhere(user?.id, user?.ccmId);
}

// One entry per vehicle; vehicles without a usable sale date are reported as data issues, never guessed.
function splitBySaleDate(records, now) {
  const seen = new Set();
  const dated = [];
  const dataIssues = [];
  for (const record of records) {
    if (!record.vehicleId || seen.has(record.vehicleId)) continue;
    seen.add(record.vehicleId);
    const saleDate = resolveSaleDate(record, now);
    if (saleDate) dated.push({ record, saleDate });
    else dataIssues.push({ recordId: record.id, vehicleId: record.vehicleId, name: record.name, vin: record.vin, registrationNumber: record.registrationNumber, reason: 'Sale date is missing or invalid' });
  }
  return { dated, dataIssues };
}

function baseRow(record, saleDate) {
  return {
    recordId: record.id,
    customerId: record.customerId,
    vehicleId: record.vehicleId,
    name: record.name,
    mobile: record.mobile,
    model: record.model,
    registrationNumber: record.registrationNumber,
    vin: record.vin,
    saleDate,
    assigneeId: record.assigneeId,
    assigneeName: record.assigneeName,
    ccmId: record.ccmId,
  };
}

function latestBy(items, key) {
  const result = new Map();
  for (const item of items) if (!result.has(item[key])) result.set(item[key], item);
  return result;
}

function workflowVisibilityWhere(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'GM') return {};
  const ccmId = user?.ccmId || 'no-access';
  if (role === 'CCM') {
    return {
      ccmId,
      OR: [
        { vehicleId: null, customer: { is: { ccmId } } },
        { vehicle: { is: { ccmId } } },
      ],
    };
  }
  if (role === 'CRE') {
    return {
      ccmId,
      customer: { is: creCustomerWhere(user) },
      AND: [{
        OR: [
          { vehicleId: null },
          { vehicle: { is: { ccmId, ...creVehicleWhere(user) } } },
        ],
      }],
    };
  }
  return { id: 'no-access' };
}

export const getFreeServiceList = withCachedResponse('free-service', loadFreeServiceList, { kind: 'workflow' });

async function loadFreeServiceList(req, res) {
  if (!canAccessServiceSource(req.user, 'FREE_SERVICE')) {
    return res.status(403).json({ message: 'You do not have permission to access Free Service.' });
  }
  const pagination = parsePagination(req.query);
  if (pagination.error) return res.status(400).json({ message: pagination.error });
  const filterValidation = filterServiceListRecords([], req.query);
  if (filterValidation.error) return res.status(400).json({ message: filterValidation.error });
  const now = new Date();
  const today = workshopToday(now);
  // Vehicles with no stored sale date are kept so the repair-order fallback and data issues still work.
  const freeServiceScope = {
    AND: [
      scopeFor(req.user),
      { vehicle: { is: { OR: [{ saleDate: null }, ...freeServiceSaleDateRanges(today).map((range) => ({ saleDate: range }))] } } },
    ],
  };
  const records = await loadCallListRecords(freeServiceScope, now, req.user);
  const { dated, dataIssues } = splitBySaleDate(records, now);
  const freePhaseVehicles = dated.filter(({ record }) => getServiceLifecycle(record, now).phase === 'free');
  const workflowWhere = workflowVisibilityWhere(req.user);

  const syncedMilestones = await syncFreeServiceMilestones(freePhaseVehicles.map(({ record, saleDate }) => ({
    id: record.vehicleId,
    physicalVehicleId: record.physicalVehicleId,
    saleDate,
    workshopVisits: record.workshopVisits,
  })));
  const milestones = filterMilestoneCompletionByVisits(
    syncedMilestones,
    freePhaseVehicles.map(({ record, saleDate }) => ({ ...record, saleDate })),
  );
  const visibleMilestones = milestones.filter((milestone) => milestone.status === 'pending'
    && isFreeServiceListVisible(milestone.dueDate, today));
  const allOpenFollowUps = req.query.followUpStatus
    ? await readByIdBatches(visibleMilestones.map(({ id }) => id), (ids) => prisma.followUp.findMany({
      where: { ...workflowWhere, source: 'FREE_SERVICE', status: 'pending', milestoneId: { in: ids } },
      orderBy: { followUpAt: 'asc' },
      select: { id: true, milestoneId: true, followUpAt: true },
    }))
    : [];
  const openFollowUpByMilestone = latestBy(allOpenFollowUps, 'milestoneId');
  const byVehicle = new Map(freePhaseVehicles.map((entry) => [entry.record.vehicleId, entry]));

  const rows = visibleMilestones.map((milestone) => {
    const { record, saleDate } = byVehicle.get(milestone.vehicleId);
    const expiryDate = freeServiceExpiryDate(milestone.dueDate);
    return {
      id: milestone.id,
      milestoneId: milestone.id,
      ...baseRow(record, saleDate),
      milestone: milestone.milestone,
      milestoneName: ['First', 'Second', 'Third'][milestone.milestone - 1] + ' free service',
      dueDate: milestone.dueDate,
      expiryDate,
      graceStatus: classifyFreeServiceStatus(milestone.dueDate, today),
      callingStartDate: freeServiceCallStart(milestone.dueDate),
      ...(req.query.followUpStatus ? { followUp: openFollowUpByMilestone.get(milestone.id) || null } : {}),
    };
  }).sort((left, right) => new Date(left.dueDate) - new Date(right.dueDate)
    || String(left.id).localeCompare(String(right.id)));

  const filtered = filterServiceListRecords(rows, req.query);
  if (filtered.error) return res.status(400).json({ message: filtered.error });
  const page = pagination.hasPagination ? paginateRecords(filtered.records, pagination) : { records: filtered.records };
  const ids = page.records.map((record) => record.milestoneId);
  // Preserve the legacy page-detail fallback when no pending Free Service follow-up exists anywhere in scope.
  const hasOpenFreeServiceFollowUps = allOpenFollowUps.length > 0
    || Boolean(ids.length && req.query.followUpStatus && await prisma.followUp.findFirst({
      where: { ...workflowWhere, source: 'FREE_SERVICE', status: 'pending' },
      select: { id: true },
    }));
  const [calls, followUps] = ids.length
    ? await Promise.all([
      readByIdBatches(ids, (batch) => prisma.callLog.findMany({ where: { ...workflowWhere, milestoneId: { in: batch } }, orderBy: { createdAt: 'desc' }, select: { milestoneId: true, outcome: true, createdAt: true } })),
      hasOpenFreeServiceFollowUps
        ? Promise.resolve(allOpenFollowUps)
        : readByIdBatches(ids, (batch) => prisma.followUp.findMany({ where: { ...workflowWhere, milestoneId: { in: batch }, status: 'pending' }, orderBy: { followUpAt: 'asc' }, select: { id: true, milestoneId: true, followUpAt: true } })),
    ])
    : [[], []];
  const lastCall = latestBy(calls, 'milestoneId');
  const openFollowUp = latestBy(followUps, 'milestoneId');
  page.records = page.records.map((record) => {
    const call = lastCall.get(record.milestoneId);
    const followUp = openFollowUp.get(record.milestoneId);
    return {
      ...record,
      callStatus: call ? 'Called' : 'Not called',
      lastCall: call ? { createdAt: call.createdAt, outcome: call.outcome } : null,
      followUp: followUp ? { id: followUp.id, followUpAt: followUp.followUpAt } : null,
    };
  });
  return res.json({
    ...page,
    dataIssues,
    asOf: zonedDateKey(now),
  });
}

export const getWarrantyList = withCachedResponse('warranty', loadWarrantyList, { kind: 'workflow' });

async function loadWarrantyList(req, res) {
  if (!canAccessServiceSource(req.user, 'WARRANTY')) {
    return res.status(403).json({ message: 'You do not have permission to access Warranty.' });
  }
  const pagination = parsePagination(req.query);
  if (pagination.error) return res.status(400).json({ message: pagination.error });
  const filterValidation = filterServiceListRecords([], req.query);
  if (filterValidation.error) return res.status(400).json({ message: filterValidation.error });
  const now = new Date();
  const today = workshopToday(now);
  const timeZone = getWorkshopTimezone();
  // Vehicles with no stored sale date are kept so the repair-order fallback and data issues still work.
  const warrantyScope = {
    AND: [
      scopeFor(req.user),
      { vehicle: { is: { OR: [{ saleDate: null }, { saleDate: warrantySaleDateRange(today) }] } } },
    ],
  };
  const records = await loadCallListRecords(warrantyScope, now, req.user);
  const { dated, dataIssues } = splitBySaleDate(records, now);
  const workflowWhere = workflowVisibilityWhere(req.user);

  const callable = dated
    .map((entry) => ({ ...entry, expiryDate: warrantyExpiryDate(entry.saleDate) }))
    .filter((entry) => isWarrantyCallable(entry.expiryDate, today));
  const contactStatusRequested = Boolean(String(req.query.contactStatus || '').trim());
  const followUpStatusRequested = Boolean(String(req.query.followUpStatus || '').trim());
  const allVehicleIds = callable.map((entry) => entry.record.vehicleId);
  const [statusCalls, statusFollowUps] = allVehicleIds.length
    ? await Promise.all([
      contactStatusRequested
        ? readByIdBatches(allVehicleIds, (ids) => prisma.callLog.findMany({ where: { ...workflowWhere, vehicleId: { in: ids }, callSource: 'WARRANTY' }, orderBy: { createdAt: 'desc' }, select: { vehicleId: true, outcome: true, createdAt: true, callSource: true } }))
        : Promise.resolve([]),
      followUpStatusRequested
        ? readByIdBatches(allVehicleIds, (ids) => prisma.followUp.findMany({ where: { ...workflowWhere, vehicleId: { in: ids }, source: 'WARRANTY', status: 'pending' }, orderBy: { followUpAt: 'asc' }, select: { id: true, vehicleId: true, followUpAt: true } }))
        : Promise.resolve([]),
    ])
    : [[], []];
  const callsByVehicle = new Map();
  for (const call of statusCalls) {
    if (!callsByVehicle.has(call.vehicleId)) callsByVehicle.set(call.vehicleId, []);
    callsByVehicle.get(call.vehicleId).push(call);
  }
  const followUpByVehicle = latestBy(statusFollowUps, 'vehicleId');

  const rows = callable.map(({ record, saleDate, expiryDate }) => {
    const vehicleCalls = callsByVehicle.get(record.vehicleId) || [];
    const window = warrantyCallingWindow(expiryDate);
    return {
      id: `${record.vehicleId}:warranty`,
      ...baseRow(record, saleDate),
      warrantyExpiryDate: expiryDate,
      callingWindow: { start: window.start, end: window.end },
      contactStatus: contactStatusRequested
        ? classifyWarrantyCase({ expiryDate, calls: vehicleCalls, now, timeZone }).contacted ? 'Contacted' : 'Not contacted'
        : null,
      followUp: followUpStatusRequested ? followUpByVehicle.get(record.vehicleId) || null : null,
    };
  }).sort((left, right) => new Date(left.warrantyExpiryDate) - new Date(right.warrantyExpiryDate)
    || String(left.id).localeCompare(String(right.id)));

  const filtered = filterServiceListRecords(rows, req.query);
  if (filtered.error) return res.status(400).json({ message: filtered.error });
  const page = pagination.hasPagination ? paginateRecords(filtered.records, pagination) : { records: filtered.records };
  const pageVehicleIds = page.records.map((record) => record.vehicleId);
  const [pageCalls, pageFollowUps] = pageVehicleIds.length
    ? await Promise.all([
      contactStatusRequested
        ? Promise.resolve(statusCalls)
        : readByIdBatches(pageVehicleIds, (ids) => prisma.callLog.findMany({ where: { ...workflowWhere, vehicleId: { in: ids }, callSource: 'WARRANTY' }, orderBy: { createdAt: 'desc' }, select: { vehicleId: true, outcome: true, createdAt: true, callSource: true } })),
      followUpStatusRequested
        ? Promise.resolve(statusFollowUps)
        : readByIdBatches(pageVehicleIds, (ids) => prisma.followUp.findMany({ where: { ...workflowWhere, vehicleId: { in: ids }, source: 'WARRANTY', status: 'pending' }, orderBy: { followUpAt: 'asc' }, select: { id: true, vehicleId: true, followUpAt: true } })),
    ])
    : [[], []];
  const pageCallsByVehicle = new Map();
  for (const call of pageCalls) {
    if (!pageCallsByVehicle.has(call.vehicleId)) pageCallsByVehicle.set(call.vehicleId, []);
    pageCallsByVehicle.get(call.vehicleId).push(call);
  }
  const pageFollowUpByVehicle = latestBy(pageFollowUps, 'vehicleId');
  page.records = page.records.map((record) => {
    const vehicleCalls = pageCallsByVehicle.get(record.vehicleId) || [];
    const followUp = pageFollowUpByVehicle.get(record.vehicleId);
    return {
      ...record,
      lastCall: vehicleCalls[0] ? { createdAt: vehicleCalls[0].createdAt, outcome: vehicleCalls[0].outcome } : null,
      contactStatus: classifyWarrantyCase({
        expiryDate: record.warrantyExpiryDate,
        calls: vehicleCalls,
        now,
        timeZone,
      }).contacted ? 'Contacted' : 'Not contacted',
      followUp: followUp ? { id: followUp.id, followUpAt: followUp.followUpAt } : null,
    };
  });
  return res.json({
    ...page,
    dataIssues,
    asOf: zonedDateKey(now),
  });
}
