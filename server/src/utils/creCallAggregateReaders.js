import { prisma } from '../config/prisma.js';
import { getCreCallCounts } from './callMetrics.js';
import { isPerformanceAggregatesEnabled } from './performanceSnapshotState.js';
import { zonedDateKey } from './workshopTime.js';

function dateKeyToDate(key) {
  return new Date(`${key}T00:00:00.000Z`);
}

function dateRangeFilter(start, end) {
  return { gte: dateKeyToDate(zonedDateKey(start)), lt: dateKeyToDate(zonedDateKey(end)) };
}

// Sums the cre_call_daily rows per CRE for the workshop days in [start, end). start and end are workshop-day
// boundary instants, so zonedDateKey maps them back to calendar days. Never touches the snapshot table.
export async function readCreCallCountsByUser({ userIds, ccmId, kind, callSources, start, end, db = prisma }) {
  const counts = new Map(userIds.map((id) => [id, { callsMade: 0, callsPickedUp: 0 }]));
  if (!userIds.length) return counts;
  const rows = await db.creCallDaily.findMany({
    where: {
      userId: { in: userIds },
      ccmId,
      scopeKind: kind,
      workshopDate: dateRangeFilter(start, end),
      callSource: callSources ? { in: callSources } : { not: 'WARRANTY' },
    },
    select: { userId: true, calls: true, answeredCalls: true },
  });
  for (const row of rows) {
    const entry = counts.get(row.userId);
    entry.callsMade += row.calls;
    entry.callsPickedUp += row.answeredCalls;
  }
  return counts;
}

export async function readCreCallCounts({ userId, ccmId, kind, callSources, start, end, db = prisma }) {
  const counts = await readCreCallCountsByUser({ userIds: [userId], ccmId, kind, callSources, start, end, db });
  return counts.get(userId);
}

export async function readCreDailyRows({ userId, ccmId, kind, callSource, start, end, db = prisma }) {
  const rows = await db.creCallDaily.findMany({
    where: {
      userId,
      ccmId,
      scopeKind: kind,
      callSource,
      calls: { gt: 0 },
      workshopDate: dateRangeFilter(start, end),
    },
    orderBy: { workshopDate: 'asc' },
  });
  return rows.map((row) => ({ date: row.workshopDate.toISOString().slice(0, 10), callsMade: row.calls, callsPickedUp: row.answeredCalls }));
}

// Single entry point for the dashboard, quota board and performance endpoints. With the flag off it is the
// original live groupBy; with it on it reads the transactional counters. `scopeWhere` is the live scope that the
// counters' `kind` (OWNED or TEAM) reproduces. A counter read failure degrades to the live query.
export async function getCreCallCountsForScope({ creIds, start, end, callSources, ccmId, kind, scopeWhere }) {
  const live = () => getCreCallCounts({ creIds, start, end, callSources, ccmId, scopeWhere });
  if (!isPerformanceAggregatesEnabled() || !ccmId || ccmId === 'no-access') return live();
  try {
    return await readCreCallCountsByUser({ userIds: creIds, ccmId, kind, callSources, start, end });
  } catch (error) {
    console.error('Call counter read failed; falling back to live call counts:', error);
    return live();
  }
}
