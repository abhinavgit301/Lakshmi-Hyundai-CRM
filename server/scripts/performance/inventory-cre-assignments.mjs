import { startScript } from './perf-db.mjs';
import { readCreAssignmentInventory } from '../../src/utils/creAssignmentInventory.js';

const { prisma } = await startScript('inventory-cre-assignments', { write: false, requireTables: false });
try {
  const inventory = await prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SET LOCAL statement_timeout = '55s'`;
      return readCreAssignmentInventory(transaction);
    },
    { isolationLevel: 'RepeatableRead', timeout: 60000, maxWait: 2000 },
  );
  console.log(JSON.stringify({ kind: 'cre-assignment-inventory', counts: inventory }, null, 2));
} finally {
  await prisma.$disconnect();
}
