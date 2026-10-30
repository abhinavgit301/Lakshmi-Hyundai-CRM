import { prisma } from '../config/prisma.js';
import { getCreCallCounts } from '../utils/callMetrics.js';
import { DAILY_TARGETS, buildQuotaNotifications, buildQuotaRows } from '../utils/serviceCalendar.js';
import { getWorkshopTimezone, parseDateKey, workshopDayRange } from '../utils/workshopTime.js';

// Only active CREs reporting to the signed-in CCM; the CCM's team is the only scope that is ever queried.
async function loadQuotaRows(ccmId, range) {
  const cres = await prisma.user.findMany({
    where: { role: 'CRE', status: 'active', ccmId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const counts = await getCreCallCounts({
    creIds: cres.map((cre) => cre.id),
    start: range.start,
    end: range.end,
    ccmId,
    scopeWhere: {
      ccmId,
      customer: { is: { ccmId } },
      AND: [{
        OR: [
          { vehicleId: null },
          { vehicle: { is: { ccmId } } },
        ],
      }],
    },
  });
  return buildQuotaRows(cres, counts);
}

// Daily quota table for the CCM's CREs. Defaults to the current reporting day.
export async function getPerformanceBoard(req, res) {
  if (!req.user?.ccmId) return res.status(403).json({ message: 'A CCM assignment is required.' });

  const now = new Date();
  const range = req.query.date ? parseDateKey(req.query.date) : workshopDayRange(now);
  if (!range) return res.status(400).json({ message: 'date must be a valid YYYY-MM-DD date.' });
  if (range.start > now) return res.status(400).json({ message: 'date cannot be in the future.' });

  const rows = await loadQuotaRows(req.user.ccmId, range);
  return res.json({ date: range.dateKey, timeZone: getWorkshopTimezone(), targets: DAILY_TARGETS, rows });
}

// Which CREs missed either daily target on the previous completed workshop day. Always computed from
// persisted call logs, so refreshes and repeat logins return identical results.
export async function getQuotaNotifications(req, res) {
  if (!req.user?.ccmId) return res.status(403).json({ message: 'A CCM assignment is required.' });

  const range = workshopDayRange(new Date(), -1);
  const rows = await loadQuotaRows(req.user.ccmId, range);
  return res.json({
    date: range.dateKey,
    timeZone: getWorkshopTimezone(),
    targets: DAILY_TARGETS,
    totalCres: rows.length,
    ...buildQuotaNotifications(rows),
  });
}
