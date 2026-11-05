// The workshop's reporting timezone. "Today", "yesterday" and month boundaries for call
// targets and warranty reporting are always evaluated in this zone, not the server's or browser's.
export function getWorkshopTimezone() {
  return process.env.WORKSHOP_TIMEZONE || 'Asia/Kolkata';
}

// IANA-style identifiers only: "UTC", "GMT" or Area/Location (Asia/Kolkata, Etc/GMT+5, America/Argentina/Buenos_Aires).
// Intl alone also accepts abbreviations such as "IST" and numeric offsets such as "+05:30", which are not stable zones.
const IANA_STYLE_ZONE = /^(?:UTC|GMT|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+)$/;

// The canonical identifier ICU reports for a zone, so aliases compare equal (Asia/Kolkata and Asia/Calcutta both
// resolve to Asia/Calcutta on current Node/ICU builds, Etc/UTC to UTC, US/Eastern to America/New_York).
export function canonicalTimezone(timeZone) {
  if (typeof timeZone !== 'string' || !IANA_STYLE_ZONE.test(timeZone)) {
    throw new Error(`"${timeZone}" is not an IANA time zone identifier such as Asia/Kolkata (abbreviations and numeric offsets are not accepted).`);
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`"${timeZone}" is not a time zone known to this Node.js runtime.`);
  }
}

export function canonicalWorkshopTimezone() {
  return canonicalTimezone(getWorkshopTimezone());
}

// Master Call List date maths (JavaScript Date getters and the SQL prototype) follow the Node process timezone, so
// the process must run in the workshop timezone. Returns both canonical zones; throws when they differ or are invalid.
export function assertProcessMatchesWorkshopTimezone(processTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const configured = getWorkshopTimezone();
  const canonicalConfigured = canonicalTimezone(configured);
  const canonicalProcess = canonicalTimezone(processTimeZone);
  if (canonicalConfigured !== canonicalProcess) {
    throw new Error(
      `Timezone mismatch: WORKSHOP_TIMEZONE is "${configured}" but the Node.js process runs in "${processTimeZone}". `
      + `Start the process with TZ=${configured} (for example TZ=Asia/Kolkata) so both agree.`,
    );
  }
  return { configured, effective: processTimeZone, canonical: canonicalConfigured };
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
