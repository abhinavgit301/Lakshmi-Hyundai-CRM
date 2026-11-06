// Strictly read-only parity check: the counter rows that cre_call_daily would hold (derived from call_logs with the
// OWNED/TEAM scope rules) versus the live getCreCallCounts query the dashboards use today.
//
//   node scripts/performance/parity-call-counters.mjs [--user <id>]
//
// Works on a database that does not have the new tables (the migration is never applied). Same safety layer as the
// other performance scripts: bench database only by default, session forced read-only. Exit 1 on any difference.
import { fail, startScript } from './perf-db.mjs';

if (process.argv.includes('--apply') || process.argv.includes('--confirm')) fail('this script is read-only');
const { args, prisma } = await startScript('parity-call-counters', { write: false, requireTables: false });
const { deriveCreCallAggregateRows } = await import('../../src/utils/creCallAggregates.js');
const { getCreCallCounts } = await import('../../src/utils/callMetrics.js');
const { creCustomerWhere, creVehicleWhere } = await import('../../src/utils/creAccess.js');
const { workshopMonthRange, zonedDateKey } = await import('../../src/utils/workshopTime.js');

// Scope filters written out exactly as recordsController / quotaController build them, independent of the helper.
function liveScope(kind, user, ccmId) {
  if (kind === 'TEAM') {
    return { ccmId, OR: [{ vehicleId: null, customer: { is: { ccmId } } }, { vehicle: { is: { ccmId } } }] };
  }
  return {
    ccmId,
    customer: { is: creCustomerWhere({ id: user.id, ccmId }) },
    AND: [{ OR: [{ vehicleId: null }, { vehicle: { is: { ccmId, ...creVehicleWhere({ id: user.id, ccmId }) } } }] }],
  };
}

const SOURCE_SETS = [
  { name: 'standard', callSources: undefined, include: (source) => source !== 'WARRANTY' },
  { name: 'free-service', callSources: ['FREE_SERVICE'], include: (source) => source === 'FREE_SERVICE' },
  { name: 'warranty', callSources: ['WARRANTY'], include: (source) => source === 'WARRANTY' },
];

const summary = { users: 0, comparisons: 0, mismatches: [], byRole: {}, categories: { transferred: 0, unassignedCcm: 0, deletedUsers: 0, freeService: 0, multiCcm: 0 } };

try {
  const allUsers = await prisma.user.findMany({ select: { id: true, role: true, ccmId: true, status: true } });
  const known = new Map(allUsers.map((user) => [user.id, user]));
  const callers = await prisma.callLog.groupBy({ by: ['createdById'], where: { createdById: { not: null } } });
  const userIds = args.values.user ? [args.values.user] : callers.map((row) => row.createdById);

  const dates = await prisma.callLog.aggregate({ _min: { createdAt: true }, _max: { createdAt: true } });
  const months = new Set();
  if (dates._min.createdAt) {
    const first = new Date(dates._min.createdAt);
    const last = new Date(dates._max.createdAt);
    for (let cursor = new Date(first); cursor <= last; cursor = new Date(cursor.getTime() + 20 * 86400000)) {
      months.add(zonedDateKey(cursor).slice(0, 7));
    }
    months.add(zonedDateKey(last).slice(0, 7));
  }
  const ranges = [{ name: 'all-time', start: new Date(0), end: new Date('2100-01-01T00:00:00Z') }];
  for (const month of [...months].sort()) {
    const [year, number] = month.split('-').map(Number);
    ranges.push({ name: month, ...workshopMonthRange(year, number) });
  }

  for (const userId of userIds) {
    const user = known.get(userId) || { id: userId, role: 'DELETED', ccmId: null, status: null };
    summary.users += 1;
    summary.byRole[user.role] = (summary.byRole[user.role] || 0) + 1;
    const derived = await deriveCreCallAggregateRows(prisma, userId);
    const ccmIds = [...new Set(derived.map((row) => row.ccmId))];
    if (ccmIds.length > 1) summary.categories.multiCcm += 1;
    if (!known.has(userId)) summary.categories.deletedUsers += 1;
    else if (!user.ccmId) summary.categories.unassignedCcm += 1;
    else if (ccmIds.some((ccmId) => ccmId !== user.ccmId)) summary.categories.transferred += 1;
    if (user.role === 'FREE_SERVICE_CRE') summary.categories.freeService += 1;

    for (const ccmId of ccmIds) {
      for (const kind of ['OWNED', 'TEAM']) {
        for (const sources of SOURCE_SETS) {
          for (const range of ranges) {
            const startKey = zonedDateKey(range.start);
            const endKey = zonedDateKey(range.end);
            let calls = 0;
            let answered = 0;
            for (const row of derived) {
              const date = row.workshopDate.toISOString().slice(0, 10);
              if (row.ccmId === ccmId && row.scopeKind === kind && sources.include(row.callSource) && date >= startKey && date < endKey) {
                calls += row.calls;
                answered += row.answeredCalls;
              }
            }
            const live = (await getCreCallCounts({
              creIds: [userId], start: range.start, end: range.end, callSources: sources.callSources, ccmId, scopeWhere: liveScope(kind, user, ccmId),
            })).get(userId);
            summary.comparisons += 1;
            if (live.callsMade !== calls || live.callsPickedUp !== answered) {
              summary.mismatches.push({ userId, role: user.role, ccmId, kind, sources: sources.name, range: range.name, live, derived: { callsMade: calls, callsPickedUp: answered } });
            }
          }
        }
      }
    }
  }
} finally {
  await prisma.$disconnect();
}

console.log(JSON.stringify({ ...summary, mismatchCount: summary.mismatches.length, mismatches: summary.mismatches.slice(0, 10) }, null, 2));
console.log(summary.mismatches.length === 0 ? 'COUNTER PARITY OK: derived counters equal live getCreCallCounts.' : 'COUNTER PARITY FAILED.');
process.exit(summary.mismatches.length === 0 ? 0 : 1);
