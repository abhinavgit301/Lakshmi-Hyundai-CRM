import { prisma } from '../config/prisma.js';
import { isAnsweredOutcome } from './serviceCalendar.js';

// Standard daily/monthly call activity per CRE, straight from persisted call logs. Each call log row is
// one attempt; warranty calls are tracked separately and never count toward the standard targets.
export async function getCreCallCounts({ creIds, start, end, callSources }) {
  const counts = new Map(creIds.map((id) => [id, { callsMade: 0, callsPickedUp: 0 }]));
  if (!creIds.length) return counts;

  const groups = await prisma.callLog.groupBy({
    by: ['createdById', 'outcome'],
    where: {
      createdById: { in: creIds },
      callSource: callSources ? { in: callSources } : { not: 'WARRANTY' },
      createdAt: { gte: start, lt: end },
    },
    _count: { _all: true },
  });

  for (const group of groups) {
    const entry = counts.get(group.createdById);
    if (!entry) continue;
    entry.callsMade += group._count._all;
    if (isAnsweredOutcome(group.outcome)) entry.callsPickedUp += group._count._all;
  }
  return counts;
}
