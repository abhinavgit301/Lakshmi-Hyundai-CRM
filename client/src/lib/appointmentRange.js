export const APPOINTMENT_PAGE_SIZE = 50;
// Safety bound for one visible range; reaching it is reported instead of silently truncating.
export const APPOINTMENT_MAX_PAGES = 40;

export function dayKeyToDate(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Local-date keys for today and the following days, matching the schedule strip.
export function upcomingDayKeys(count, now = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });
}

// The server filters scheduledAt >= from and < to, so `to` is the local midnight after the last visible day.
export function appointmentWindowFor(dayKeys) {
  const keys = [...dayKeys].filter(Boolean).sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  const from = dayKeyToDate(first);
  const to = dayKeyToDate(last);
  to.setDate(to.getDate() + 1);
  return {
    key: `${first}..${last}`,
    from: from.toISOString(),
    to: to.toISOString(),
    fromMs: from.getTime(),
    toMs: to.getTime(),
  };
}

export function isInWindow(window, scheduledAt) {
  if (!window) return false;
  const time = new Date(scheduledAt).getTime();
  return time >= window.fromMs && time < window.toMs;
}

// Loads every page of one range. Offset paging can repeat a row if data changes mid-load, so rows are de-duplicated by id.
export async function fetchAppointmentWindow(get, window, {
  signal,
  pageSize = APPOINTMENT_PAGE_SIZE,
  maxPages = APPOINTMENT_MAX_PAGES,
} = {}) {
  const byId = new Map();
  let fetched = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      from: window.from,
      to: window.to,
      limit: String(pageSize),
      offset: String(fetched),
    });
    const response = await get(`/appointments?${params}`, { signal });
    const batch = response.data.appointments || [];
    fetched += batch.length;
    for (const row of batch) byId.set(row.id, row);
    if (response.data.hasMore !== true || batch.length === 0) {
      return { rows: [...byId.values()], truncated: false };
    }
  }
  return { rows: [...byId.values()], truncated: true };
}
