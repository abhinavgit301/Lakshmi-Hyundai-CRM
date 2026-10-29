// The workshop's reporting timezone. "Today", "yesterday" and month boundaries for call
// targets and warranty reporting are always evaluated in this zone, not the server's or browser's.
export function getWorkshopTimezone() {
  return process.env.WORKSHOP_TIMEZONE || 'Asia/Kolkata';
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

function zoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant at which the given calendar day begins in the timezone. Day/month overflow
// (e.g. day 0 or month 13) is normalised the same way Date.UTC does.
export function zonedStartOfDay(year, month, day, timeZone = getWorkshopTimezone()) {
  const guess = Date.UTC(year, month - 1, day);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  const corrected = zoneOffsetMs(new Date(result), timeZone);
  if (corrected !== offset) {
    offset = corrected;
    result = guess - offset;
  }
  return new Date(result);
}

export function zonedDateKey(date, timeZone = getWorkshopTimezone()) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Start (inclusive) and end (exclusive) of the workshop day containing `date`, shifted by `dayOffset` days.
export function workshopDayRange(date = new Date(), dayOffset = 0, timeZone = getWorkshopTimezone()) {
  const { year, month, day } = zonedParts(date, timeZone);
  const start = zonedStartOfDay(year, month, day + dayOffset, timeZone);
  const end = zonedStartOfDay(year, month, day + dayOffset + 1, timeZone);
  return { start, end, dateKey: zonedDateKey(start, timeZone) };
}

export function parseDateKey(value, timeZone = getWorkshopTimezone()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const start = zonedStartOfDay(year, month, day, timeZone);
  if (zonedDateKey(start, timeZone) !== value) return null;
  return { start, end: zonedStartOfDay(year, month, day + 1, timeZone), dateKey: value };
}

export function workshopMonthRange(year, month, timeZone = getWorkshopTimezone()) {
  return { start: zonedStartOfDay(year, month, 1, timeZone), end: zonedStartOfDay(year, month + 1, 1, timeZone) };
}

export function workshopMonthOf(date = new Date(), timeZone = getWorkshopTimezone()) {
  const { year, month } = zonedParts(date, timeZone);
  return { year, month };
}

// Today's calendar date in the workshop timezone as a local-midnight Date, for date-only arithmetic.
export function workshopToday(now = new Date(), timeZone = getWorkshopTimezone()) {
  const { year, month, day } = zonedParts(now, timeZone);
  return new Date(year, month - 1, day);
}
