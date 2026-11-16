import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { flushCreCallAggregates } from '../utils/creCallAggregates.js';
import { signalSnapshotRefresh } from '../utils/performanceRefreshSignal.js';
import { beginSnapshotInvalidation, flushSnapshotInvalidation } from '../utils/performanceSnapshotState.js';

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

// Flush aggregate rebuilds before revision and snapshot locks, then commit source changes and invalidations
// together. Ownership-triggered refreshes are requested after commit.
const runTransaction = prisma.$transaction.bind(prisma);
prisma.$transaction = async (work, ...options) => {
  if (typeof work !== 'function') return runTransaction(work, ...options);
  let changed = false;
  const result = await runTransaction(async (transaction) => {
    beginSnapshotInvalidation(transaction);
    const output = await work(transaction);
    ({ changed } = await flushCreCallAggregates(transaction));
    await flushSnapshotInvalidation(transaction);
    return output;
  }, ...options);
  if (changed) signalSnapshotRefresh();
  return result;
};
