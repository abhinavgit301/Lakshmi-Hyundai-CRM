import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { flushCreCallAggregates } from '../utils/creCallAggregates.js';
import { signalSnapshotRefresh } from '../utils/performanceRefreshSignal.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured.');
}

const poolMax = Number.parseInt(process.env.DB_POOL_MAX, 10);
const adapter = new PrismaPg({
  connectionString,
  ...(poolMax > 0 ? { max: poolMax } : {}),
});

export const prisma = new PrismaClient({
  adapter,
});

// Ownership and account writes note the CREs they affect. Flushing here re-derives their call aggregates and
// flags their snapshots dirty inside the same transaction, so no such change can commit without them. The
// refresh is requested only after the commit; the 60-second scheduler remains the recovery path.
const runTransaction = prisma.$transaction.bind(prisma);
prisma.$transaction = async (work, ...options) => {
  if (typeof work !== 'function') return runTransaction(work, ...options);
  let changed = false;
  const result = await runTransaction(async (transaction) => {
    const output = await work(transaction);
    ({ changed } = await flushCreCallAggregates(transaction));
    return output;
  }, ...options);
  if (changed) signalSnapshotRefresh();
  return result;
};
