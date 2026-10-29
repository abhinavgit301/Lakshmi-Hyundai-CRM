import { prisma } from '../config/prisma.js';

const SERVICE_CATEGORIES = ['Free Service', 'PMS', 'Accidental Repair', 'Running Repair', 'Others'];

function getServiceCategory(workType) {
  const value = String(workType || '').trim().toLowerCase();
  if (/\b(free|foc)\b/.test(value)) return 'Free Service';
  if (/\b(accident|accidental|collision|body shop)\b/.test(value)) return 'Accidental Repair';
  if (/\b(running repair|running repairs|rr)\b/.test(value)) return 'Running Repair';
  if (/\b(pms|periodic)\b/.test(value)) return 'PMS';
  return 'Others';
}

function parseMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month] = value.split('-').map(Number);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

export { SERVICE_CATEGORIES, getServiceCategory, parseMonth };

export async function queryWorkshopServiceData({ startMonth, endMonth, serviceType = 'All', ccmId = null }) {
  const start = parseMonth(startMonth);
  const end = parseMonth(endMonth);
  if (!start || !end) return null;

  const startDate = new Date(start.year, start.month - 1, 1);
  const endDateExclusive = new Date(end.year, end.month, 1);
  const monthCount = (end.year - start.year) * 12 + end.month - start.month + 1;
  if (endDateExclusive <= startDate || monthCount > 120) return null;

  const [visits, historyCount, undatedHistoryCount] = await Promise.all([
    ccmId
      ? prisma.$queryRaw`
        SELECT
          EXTRACT(YEAR FROM "visitDate")::int AS "year",
          EXTRACT(MONTH FROM "visitDate")::int AS "month",
          EXTRACT(DAY FROM "visitDate")::int AS "day",
          "importedDetails"->>'workType' AS "workType",
          COUNT(*)::int AS "count"
        FROM workshop_visits
        WHERE "visitDate" >= ${startDate} AND "visitDate" < ${endDateExclusive} AND "ccmId" = ${ccmId}
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3
      `
      : prisma.$queryRaw`
        SELECT
          EXTRACT(YEAR FROM "visitDate")::int AS "year",
          EXTRACT(MONTH FROM "visitDate")::int AS "month",
          EXTRACT(DAY FROM "visitDate")::int AS "day",
          "importedDetails"->>'workType' AS "workType",
          COUNT(*)::int AS "count"
        FROM workshop_visits
        WHERE "visitDate" >= ${startDate} AND "visitDate" < ${endDateExclusive}
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3
      `,
    prisma.workshopVisit.count({ where: ccmId ? { ccmId } : {} }),
    prisma.workshopVisit.count({ where: { visitDate: null, ...(ccmId ? { ccmId } : {}) } }),
  ]);

  const months = Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(start.year, start.month - 1 + index, 1);
    return {
      month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      total: 0,
      categories: Object.fromEntries(SERVICE_CATEGORIES.map((category) => [category, 0])),
    };
  });
  const monthMap = new Map(months.map((entry) => [entry.month, entry]));
  const dailyMap = new Map();
  let filteredRangeCount = 0;
  let rangeCount = 0;

  for (const visit of visits) {
    const month = `${visit.year}-${String(visit.month).padStart(2, '0')}`;
    const monthData = monthMap.get(month);
    if (!monthData) continue;
    const count = Number(visit.count);
    const category = getServiceCategory(visit.workType);
    monthData.categories[category] += count;
    monthData.total += count;
    rangeCount += count;
    if (serviceType === 'All' || serviceType === category) filteredRangeCount += count;

    const dateKey = `${month}-${String(visit.day).padStart(2, '0')}`;
    const dailyData = dailyMap.get(dateKey) || {
      date: dateKey,
      total: 0,
      categories: Object.fromEntries(SERVICE_CATEGORIES.map((name) => [name, 0])),
    };
    dailyData.categories[category] += count;
    dailyData.total += count;
    dailyMap.set(dateKey, dailyData);
  }

  return {
    categories: SERVICE_CATEGORIES,
    startMonth,
    endMonth,
    serviceType,
    ccmId: ccmId || null,
    rangeCount,
    filteredRangeCount,
    historyCount,
    undatedHistoryCount,
    months,
    daily: [...dailyMap.values()].sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export async function getWorkshopServicePerformance(req, res) {
  const start = parseMonth(req.query.startMonth);
  const end = parseMonth(req.query.endMonth);
  const serviceType = String(req.query.serviceType || 'All');
  if (!start || !end || (!SERVICE_CATEGORIES.includes(serviceType) && serviceType !== 'All')) {
    return res.status(400).json({ message: 'Valid startMonth, endMonth, and serviceType filters are required.' });
  }

  const role = String(req.user?.role || '').toUpperCase();
  // A CCM only ever sees their own team's service volume; GM/Admin may optionally filter to one team.
  const ccmId = role === 'CCM' ? req.user.ccmId : String(req.query.ccmId || '').trim() || null;
  if (role === 'CCM' && !ccmId) {
    return res.status(403).json({ message: 'A CCM assignment is required to view workshop performance.' });
  }

  const result = await queryWorkshopServiceData({
    startMonth: req.query.startMonth,
    endMonth: req.query.endMonth,
    serviceType,
    ccmId,
  });

  if (!result) {
    return res.status(400).json({ message: 'The selected date range must be chronological and no longer than 120 months.' });
  }

  return res.json(result);
}
