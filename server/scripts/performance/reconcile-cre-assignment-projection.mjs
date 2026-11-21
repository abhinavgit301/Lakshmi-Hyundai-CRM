import { startScript } from './perf-db.mjs';
import { reconcileCreAssignmentProjection } from '../../src/utils/creAssignmentProjection.js';

const { prisma } = await startScript('reconcile-cre-assignment-projection', { write: false, requireTables: false });
try {
  const counts = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SET LOCAL statement_timeout = '55s'`;
    return reconcileCreAssignmentProjection(transaction);
  }, { isolationLevel: 'RepeatableRead', timeout: 60000, maxWait: 2000 });
  console.log(JSON.stringify({ kind: 'cre-assignment-projection-reconciliation', counts }, null, 2));
  if (Object.values(counts).some((value) => value !== '0')) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
