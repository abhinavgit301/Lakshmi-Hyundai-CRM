export function parseStoredDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const local = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const date = local ? new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1])) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Adds calendar months, clamping to the last day of shorter months (31 Aug + 6 months = 28/29 Feb).
export function addMonths(date, months) {
  const result = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(date.getDate(), lastDay));
  return result;
}

export function getYearlyDueDate(visits) {
  const dates = visits.map((visit) => parseStoredDate(visit.visitDate)).filter(Boolean);
  if (!dates.length) return null;
  const last = new Date(Math.max(...dates.map((date) => date.getTime())));
  return new Date(last.getFullYear() + 1, last.getMonth(), last.getDate());
}

// The latest qualifying service is the most recent dated repair order that is not in the future.
export function getLatestServiceDate(visits, now = new Date()) {
  const dates = visits.map((visit) => parseStoredDate(visit.visitDate)).filter((date) => date && date <= now);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

// '1y' when the latest service was exactly 12 calendar months before `now`'s month (e.g. this
// January's 1-Year Due cohort = vehicles last serviced last January); '6m' for exactly 6 months before.
// This is a month-wise cohort, not a rolling/overdue window: a vehicle leaves the cohort once the
// calendar month moves on, even if it was never actioned.
export function classifyServiceDue(lastServiceDate, now = new Date()) {
  if (!lastServiceDate) return null;
  const monthsAgo = (now.getFullYear() - lastServiceDate.getFullYear()) * 12 + (now.getMonth() - lastServiceDate.getMonth());
  if (monthsAgo === 12) return '1y';
  if (monthsAgo === 6) return '6m';
  return null;
}

// Date ranges (one per cohort) that bound every lastServiceDate classifyServiceDue can place in that
// cohort. Used only to narrow database candidates, so each range is widened by a day on both sides and
// classifyServiceDue remains the authoritative check.
export function dueCohortServiceDateRanges(now = new Date()) {
  const range = (monthsAgo) => {
    const gte = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    const lt = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
    gte.setDate(gte.getDate() - 1);
    lt.setDate(lt.getDate() + 1);
    return { gte, lt };
  };
  return { oneYear: range(12), sixMonth: range(6) };
}
