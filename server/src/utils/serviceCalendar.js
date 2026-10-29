// Business rules for Free Service milestones, warranty windows, call-quota evaluation and
// follow-up routing. Everything here is pure so it can be tested without a database.
import { addMonths, parseStoredDate } from './serviceDue.js';
import { zonedStartOfDay } from './workshopTime.js';

export const DAILY_TARGETS = { callsMade: 120, callsPickedUp: 80 };

export const FREE_SERVICE_MILESTONES = [
  { milestone: 1, months: 2, name: 'First free service' },
  { milestone: 2, months: 12, name: 'Second free service' },
  { milestone: 3, months: 24, name: 'Third free service' },
];
export const FREE_SERVICE_CALL_LEAD_DAYS = 14;
export const WARRANTY_YEARS = 3;

// Outcomes where the customer did not actually pick up and speak: no answer, or a wrong number.
const UNANSWERED_OUTCOMES = ['NO_RESPONSE', 'WRONG_NUMBER'];

export function isAnsweredOutcome(outcome) {
  return Boolean(outcome) && !UNANSWERED_OUTCOMES.includes(outcome);
}

export const FOLLOW_UP_SOURCE_BY_LIST = {
  '1y': 'SERVICE',
  '6m': 'SERVICE',
  free: 'FREE_SERVICE',
  warranty: 'WARRANTY',
};

export function routeFollowUpSource(list) {
  return FOLLOW_UP_SOURCE_BY_LIST[list] || 'SERVICE';
}

// A sale date is only usable when it parses to a real calendar date that is not in the future.
// Missing or invalid dates are never replaced by an import or current date.
export function normalizeSaleDate(value, now = new Date()) {
  const parsed = parseStoredDate(value);
  if (!parsed) return null;
  const calendar = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  return calendar > now ? null : calendar;
}

export function freeServiceDueDate(saleDate, milestone) {
  const definition = FREE_SERVICE_MILESTONES.find((entry) => entry.milestone === milestone);
  return definition ? addMonths(saleDate, definition.months) : null;
}

export function freeServiceCallStart(dueDate) {
  return new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate() - FREE_SERVICE_CALL_LEAD_DAYS);
}

export function isFreeServiceWorkType(workType) {
  return /\b(free|foc)\b/i.test(String(workType || ''));
}

// Visible to the CRE only when the calling window has opened (14 days before due) AND the due date
// is today or later and no later than one calendar month from today (inclusive).
export function isFreeServiceCallable(dueDate, today) {
  return today >= freeServiceCallStart(dueDate) && dueDate >= today && dueDate <= addMonths(today, 1);
}

// A repair order only completes a milestone when it is explicitly a free-service work type and the
// visit falls within a month either side of the due date. Anything else is left pending.
export function findCompletingVisit(dueDate, visits) {
  const windowStart = addMonths(dueDate, -1);
  const windowEnd = addMonths(dueDate, 1);
  return (visits || [])
    .filter((visit) => isFreeServiceWorkType(visit.importedDetails?.workType))
    .map((visit) => ({ visit, date: parseStoredDate(visit.visitDate) }))
    .filter(({ date }) => date && date >= windowStart && date <= windowEnd)
    .sort((left, right) => left.date - right.date)[0]?.visit || null;
}

export function freeServiceOverlapsMonth(dueDate, year, month) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  return freeServiceCallStart(dueDate) <= monthEnd && dueDate >= monthStart;
}

// Prefers the sale date stored on the vehicle and falls back to the imported repair-order details.
export function resolveSaleDate(record, now = new Date()) {
  const stored = normalizeSaleDate(record.saleDate, now);
  if (stored) return stored;
  return (record.workshopVisits || []).map((visit) => normalizeSaleDate(visit.importedDetails?.saleDate, now)).find(Boolean) || null;
}

// Customers (unique) with at least one free-service milestone whose calling window overlaps the month.
// This is the free-service share of a CRE's assigned workload; it does not depend on milestone status.
export function freeServiceCustomerIdsForMonth(records, year, month, now = new Date()) {
  const ids = new Set();
  for (const record of records) {
    const saleDate = resolveSaleDate(record, now);
    if (!saleDate || !record.customerId) continue;
    if (FREE_SERVICE_MILESTONES.some(({ milestone }) => freeServiceOverlapsMonth(freeServiceDueDate(saleDate, milestone), year, month))) {
      ids.add(record.customerId);
    }
  }
  return ids;
}

export function warrantyExpiryDate(saleDate) {
  return addMonths(saleDate, WARRANTY_YEARS * 12);
}

// The whole calendar month before the expiry month, first to last day inclusive.
export function warrantyCallingWindow(expiryDate) {
  return {
    start: new Date(expiryDate.getFullYear(), expiryDate.getMonth() - 1, 1),
    end: new Date(expiryDate.getFullYear(), expiryDate.getMonth(), 0),
  };
}

export function isWarrantyCallable(expiryDate, today) {
  const { start, end } = warrantyCallingWindow(expiryDate);
  return today >= start && today <= end;
}

// The instant the warranty has lapsed: the start of the day after the expiry date in the workshop timezone.
export function warrantyLapseInstant(expiryDate, timeZone) {
  return zonedStartOfDay(expiryDate.getFullYear(), expiryDate.getMonth() + 1, expiryDate.getDate() + 1, timeZone);
}

// A case is one vehicle's warranty. It is missed when it has lapsed with no answered warranty call before the lapse.
export function classifyWarrantyCase({ expiryDate, calls, now = new Date(), timeZone }) {
  const lapse = warrantyLapseInstant(expiryDate, timeZone);
  const expired = now >= lapse;
  const contacted = (calls || []).some((call) => call.callSource === 'WARRANTY'
    && isAnsweredOutcome(call.outcome)
    && new Date(call.createdAt) < lapse);
  return { expired, contacted, missed: expired && !contacted };
}

// One case per vehicle (duplicates collapse), missed when it lapsed with no answered warranty call before the lapse.
export function findMissedCases(entries, { now = new Date(), timeZone } = {}) {
  const byVehicle = new Map();
  for (const entry of entries) if (!byVehicle.has(entry.vehicleId)) byVehicle.set(entry.vehicleId, entry);
  return [...byVehicle.values()]
    .filter((entry) => classifyWarrantyCase({ expiryDate: entry.expiryDate, calls: entry.calls, now, timeZone }).missed);
}

export function evaluateQuota({ callsMade = 0, callsPickedUp = 0 }, targets = DAILY_TARGETS) {
  return {
    callsMade,
    callsMadeTarget: targets.callsMade,
    callsMadeMet: callsMade >= targets.callsMade,
    callsMadeShortfall: Math.max(0, targets.callsMade - callsMade),
    callsPickedUp,
    callsPickedUpTarget: targets.callsPickedUp,
    callsPickedUpMet: callsPickedUp >= targets.callsPickedUp,
    callsPickedUpShortfall: Math.max(0, targets.callsPickedUp - callsPickedUp),
  };
}

// One row per CRE, including CREs with no calls at all.
export function buildQuotaRows(cres, countsByCre, targets = DAILY_TARGETS) {
  return cres.map((cre) => ({
    creId: cre.id,
    creName: cre.name,
    ...evaluateQuota(countsByCre.get(cre.id) || {}, targets),
  }));
}

export function buildQuotaNotifications(rows) {
  return {
    callsMadeMissed: rows.filter((row) => !row.callsMadeMet).map((row) => ({
      creId: row.creId, creName: row.creName, actual: row.callsMade, target: row.callsMadeTarget, shortfall: row.callsMadeShortfall,
    })),
    callsPickedUpMissed: rows.filter((row) => !row.callsPickedUpMet).map((row) => ({
      creId: row.creId, creName: row.creName, actual: row.callsPickedUp, target: row.callsPickedUpTarget, shortfall: row.callsPickedUpShortfall,
    })),
  };
}
