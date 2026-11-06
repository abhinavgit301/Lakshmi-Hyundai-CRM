// Strictly read-only reconciliation of cre_call_daily against call_logs.
//
//   node scripts/performance/reconcile-performance-aggregates.mjs [--user <id>] [--out report.json]
//
// The session is forced read-only (default_transaction_read_only=on, verified before any query), and the script
// accepts no write flags. Exit code 0 = no mismatches, 1 = mismatches or errors, 2 = refused by a safety check.
import { writeFileSync } from 'node:fs';
import { fail, startScript } from './perf-db.mjs';

if (process.argv.includes('--apply') || process.argv.includes('--confirm')) {
  fail('the reconcile script is read-only; use repair-performance-aggregates.mjs to write');
}
const { args, prisma } = await startScript('reconcile-performance-aggregates', { write: false });
const { auditCreCallAggregates, listAggregateUserIds } = await import('../../src/utils/creCallAggregateAudit.js');

const report = { users: 0, usersWithMismatches: 0, mismatchedRows: 0, details: [], snapshots: {} };
try {
  const userIds = args.values.user ? [args.values.user] : await listAggregateUserIds(prisma);
  for (const userId of userIds) {
    const audit = await auditCreCallAggregates(prisma, userId);
    report.users += 1;
    if (audit.mismatches.length) {
      report.usersWithMismatches += 1;
      report.mismatchedRows += audit.mismatches.length;
      report.details.push({ userId, mismatches: audit.mismatches.slice(0, 50), truncated: audit.mismatches.length > 50 });
    }
  }

  const [statusGroups, orphaned] = await Promise.all([
    prisma.crePerformanceSnapshot.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.$queryRaw`SELECT count(*)::int AS n FROM cre_performance_snapshots s
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s."creId" AND u."ccmId" = s."ccmId")`,
  ]);
  report.snapshots = {
    byStatus: Object.fromEntries(statusGroups.map((group) => [group.status, group._count._all])),
    orphaned: orphaned[0]?.n ?? 0,
  };
} finally {
  await prisma.$disconnect();
}
if (args.values.out) writeFileSync(args.values.out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, details: report.details.slice(0, 5) }, null, 2));
const clean = report.usersWithMismatches === 0 && report.snapshots.orphaned === 0;
console.log(clean ? 'RECONCILE OK: stored aggregates match call_logs.' : 'RECONCILE FOUND DIFFERENCES (nothing was changed).');
process.exit(clean ? 0 : 1);
