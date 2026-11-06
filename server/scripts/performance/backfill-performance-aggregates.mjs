// Idempotent backfill of cre_call_daily (and optional pending snapshot rows).
//
//   node scripts/performance/backfill-performance-aggregates.mjs                 dry run (read-only session)
//   node scripts/performance/backfill-performance-aggregates.mjs --apply         writes, one transaction per CRE
//   options: --seed-snapshots  --user <id>  --batch-size <n>
//
// Never runs at server start. Does not create tables: the migration must already be applied to the target.
// Target safety rules are in perf-db.mjs (default target: the local benchmark database only).
import { startScript } from './perf-db.mjs';

const apply = process.argv.includes('--apply');
const { args, prisma } = await startScript('backfill-performance-aggregates', { write: apply });
const { auditCreCallAggregates, listAggregateUserIds, repairCreCallAggregates } = await import('../../src/utils/creCallAggregateAudit.js');
const { workshopMonthOf } = await import('../../src/utils/workshopTime.js');

const batchSize = Math.max(1, Number.parseInt(args.values['batch-size'], 10) || 25);
const onlyUser = args.values.user;
const summary = { users: 0, changed: 0, unchanged: 0, failed: 0, rowsMismatched: 0, snapshotRowsSeeded: 0 };

try {
  const userIds = onlyUser ? [onlyUser] : await listAggregateUserIds(prisma);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${userIds.length} user(s) in batches of ${batchSize}`);
  for (let offset = 0; offset < userIds.length; offset += batchSize) {
    for (const userId of userIds.slice(offset, offset + batchSize)) {
      summary.users += 1;
      try {
        if (apply) {
          const result = await repairCreCallAggregates(prisma, userId, { markSnapshotsDirty: false });
          summary[result.changed ? 'changed' : 'unchanged'] += 1;
          summary.rowsMismatched += result.mismatches;
        } else {
          const audit = await auditCreCallAggregates(prisma, userId);
          summary[audit.mismatches.length ? 'changed' : 'unchanged'] += 1;
          summary.rowsMismatched += audit.mismatches.length;
        }
      } catch (error) {
        summary.failed += 1;
        console.error(`user ${userId} failed: ${error.message}`);
      }
    }
    console.log(`batch ${Math.floor(offset / batchSize) + 1}: processed ${Math.min(offset + batchSize, userIds.length)}/${userIds.length}`);
  }

  if (args.flags.has('seed-snapshots')) {
    const { year, month } = workshopMonthOf(new Date());
    const [cres, freeServiceCres] = await Promise.all([
      prisma.user.findMany({ where: { role: 'CRE', status: 'active', ccmId: { not: null } }, select: { id: true, ccmId: true } }),
      prisma.user.findMany({ where: { role: 'FREE_SERVICE_CRE', status: 'active', ccmId: { not: null } }, select: { id: true, ccmId: true } }),
    ]);
    const data = [
      ...cres.flatMap((cre) => ['CRE', 'CCM'].map((viewer) => ({ creId: cre.id, ccmId: cre.ccmId, year, month, viewer }))),
      ...freeServiceCres.map((cre) => ({ creId: cre.id, ccmId: cre.ccmId, year, month, viewer: 'FREE_SERVICE_CRE' })),
    ];
    if (apply) summary.snapshotRowsSeeded = (await prisma.crePerformanceSnapshot.createMany({ data, skipDuplicates: true })).count;
    else console.log(`DRY RUN: would seed up to ${data.length} pending snapshot rows for ${year}-${month}`);
  }
} finally {
  await prisma.$disconnect();
}
console.log(`Summary: ${JSON.stringify(summary)}`);
if (!apply) console.log('Dry run only: nothing was written. Re-run with --apply to write.');
process.exit(summary.failed ? 1 : 0);
