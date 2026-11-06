// Explicit repair: rewrites cre_call_daily only for users whose rows differ from call_logs, and flags their
// current-month snapshots dirty. Separate from the read-only reconcile script on purpose.
//
//   node scripts/performance/repair-performance-aggregates.mjs                dry run: lists what would change
//   node scripts/performance/repair-performance-aggregates.mjs --apply        repairs, one transaction per user
//   options: --user <id>  --max-users <n> (default 200, a blast-radius limit)
import { startScript } from './perf-db.mjs';

const apply = process.argv.includes('--apply');
const { args, prisma } = await startScript('repair-performance-aggregates', { write: apply });
const { auditCreCallAggregates, listAggregateUserIds, repairCreCallAggregates } = await import('../../src/utils/creCallAggregateAudit.js');

const maxUsers = Math.max(1, Number.parseInt(args.values['max-users'], 10) || 200);
const result = { checked: 0, needsRepair: 0, repaired: 0, failed: 0 };
try {
  const userIds = args.values.user ? [args.values.user] : await listAggregateUserIds(prisma);
  const broken = [];
  for (const userId of userIds) {
    result.checked += 1;
    const audit = await auditCreCallAggregates(prisma, userId);
    if (audit.mismatches.length) broken.push({ userId, mismatches: audit.mismatches.length });
  }
  result.needsRepair = broken.length;
  console.log(`${broken.length} user(s) need repair: ${JSON.stringify(broken.slice(0, 20))}`);
  if (apply && broken.length > maxUsers) {
    console.error(`refusing to repair ${broken.length} users (limit ${maxUsers}); investigate, or raise --max-users`);
    process.exitCode = 2;
  } else if (apply) {
    for (const { userId } of broken) {
      try {
        const outcome = await repairCreCallAggregates(prisma, userId);
        if (outcome.changed) result.repaired += 1;
      } catch (error) {
        result.failed += 1;
        console.error(`user ${userId} failed: ${error.message}`);
      }
    }
  }
} finally {
  await prisma.$disconnect();
}
console.log(`Summary: ${JSON.stringify(result)}`);
if (!apply) console.log('Dry run only: nothing was written. Re-run with --apply to repair.');
process.exit(process.exitCode || (result.failed ? 1 : 0));
