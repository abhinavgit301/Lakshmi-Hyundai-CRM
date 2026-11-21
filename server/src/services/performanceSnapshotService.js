import { prisma } from '../config/prisma.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  computeCrePerformanceMetrics,
  computeFreeServiceCrePerformanceMetrics,
} from '../controllers/callWorkflowController.js';
import { workshopMonthOf } from '../utils/workshopTime.js';
import { invalidateCallListCache } from '../utils/callListCache.js';
import { setSnapshotRefreshHandler } from '../utils/performanceRefreshSignal.js';
import { createSnapshotTrace, traceSnapshotPhase } from '../utils/performanceSnapshotTrace.js';
import {
  HISTORICAL_SNAPSHOT_MAX_AGE_MS,
  isPerformanceAggregateMaintenanceEnabled,
  SNAPSHOT_MAX_AGE_MS,
} from '../utils/performanceSnapshotState.js';

// Refreshing early keeps the served snapshot inside the 15-minute staleness limit despite scheduler jitter.
const REFRESH_AFTER_MS = 10 * 60 * 1000;
const REFRESH_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 60 * 1000;
const KICK_DELAY_MS = 2000;
const BATCH_SIZE = 20;
const DEFAULT_REFRESH_CONCURRENCY = 2;
const MAX_ERROR_LENGTH = 500;
const CONSISTENT_READ_TIMEOUT_MS = 60 * 1000;
const CONSISTENT_READ_MAX_WAIT_MS = 2000;

export function isSnapshotConsistentReadsEnabled(env = process.env) {
  return ['true', '1'].includes(String(env.PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED || '').trim().toLowerCase());
}

export function snapshotRefreshConcurrency(env = process.env) {
  const value = String(env.PERFORMANCE_SNAPSHOT_REFRESH_CONCURRENCY ?? '').trim();
  if (!value) return DEFAULT_REFRESH_CONCURRENCY;
  if (value !== '1' && value !== '2') {
    throw new Error('PERFORMANCE_SNAPSHOT_REFRESH_CONCURRENCY must be 1 or 2.');
  }
  return Number(value);
}

const VIEWERS = ['CRE', 'CCM'];
const requested = new Map();
let kickTimer = null;
let schedulerTimer = null;
let ticking = false;

export function snapshotWhere({ creId, ccmId, year, month, viewer }) {
  return { creId_ccmId_year_month_viewer: { creId, ccmId, year, month, viewer } };
}

function keyOf(key) {
  return `${key.creId}|${key.ccmId}|${key.year}|${key.month}|${key.viewer}`;
}

export async function getSnapshot(key, db = prisma) {
  return db.crePerformanceSnapshot.findUnique({ where: snapshotWhere(key) });
}

// Recalculates one snapshot. A failure records the error and keeps the last good values.
export async function refreshSnapshot(key, {
  now = new Date(),
  db = prisma,
  compute = computeCrePerformanceMetrics,
  computeFreeService = computeFreeServiceCrePerformanceMetrics,
} = {}) {
  const trace = createSnapshotTrace(key);
  return traceSnapshotPhase(trace, 'attempt', () => refreshSnapshotWithTrace(
    key, { now, db, compute, computeFreeService, trace },
  ));
}

async function refreshSnapshotWithTrace(key, { now, db, compute, computeFreeService, trace }) {
  const where = {
    creId: key.creId, ccmId: key.ccmId, year: key.year, month: key.month, viewer: key.viewer,
  };
  await traceSnapshotPhase(trace, 'ensure_row', () => db.crePerformanceSnapshot.createMany({ data: [{ ...where }], skipDuplicates: true }));
  const claimToken = randomUUID();
  const claimed = await traceSnapshotPhase(trace, 'claim', () => db.crePerformanceSnapshot.updateMany({
    where: {
      ...where,
      OR: [
        { status: { not: 'refreshing' } },
        { refreshStartedAt: { lt: new Date(now.getTime() - REFRESH_LOCK_TIMEOUT_MS) } },
      ],
    },
    data: { status: 'refreshing', refreshStartedAt: now, lastAttemptAt: now, claimToken },
  }));
  trace.emit('claim_result', { outcome: claimed.count ? 'claimed' : 'already_refreshing' });
  if (!claimed.count) return { refreshed: false, reason: 'already-refreshing' };

  try {
    const ccmScope = `ccm:${key.ccmId}`;
    await db.performanceSnapshotRevision.createMany({ data: [{ scope: ccmScope }], skipDuplicates: true });
    const revisions = await db.performanceSnapshotRevision.findMany({
      where: { scope: { in: ['global', ccmScope] } },
    });
    const globalRevision = revisions.find((row) => row.scope === 'global')?.revision;
    const ccmRevision = revisions.find((row) => row.scope === ccmScope)?.revision;
    if (globalRevision == null || ccmRevision == null) throw new Error('Snapshot revision rows are missing.');
    const claimedRow = await db.crePerformanceSnapshot.findUnique({ where: snapshotWhere(key) });
    if (!claimedRow || claimedRow.claimToken !== claimToken) {
      trace.emit('attempt_result', { outcome: 'superseded' });
      return { refreshed: false, reason: 'superseded' };
    }
    const dirtyVersion = claimedRow.dirtyVersion;
    const expectedRole = key.viewer === 'FREE_SERVICE_CRE' ? 'FREE_SERVICE_CRE' : 'CRE';
    const consistent = isSnapshotConsistentReadsEnabled();
    const calculate = async (readDb) => {
      const user = await traceSnapshotPhase(trace, 'user_lookup', () => readDb.user.findFirst({
        where: { id: key.creId, role: expectedRole },
        select: { id: true, name: true, ccmId: true, freeServiceEnabled: true, warrantyEnabled: true },
      }));
      if (!user || user.ccmId !== key.ccmId) return null;
      return traceSnapshotPhase(trace, 'compute', () => (
        key.viewer === 'FREE_SERVICE_CRE'
          ? computeFreeService({ targetCre: user, year: key.year, month: key.month, now, db: readDb, trace })
          : compute({ targetCre: user, viewer: key.viewer, year: key.year, month: key.month, now, db: readDb, trace, deferClassification: consistent })
      ));
    };
    const inputs = consistent
      ? await traceSnapshotPhase(trace, 'consistent_read', () => db.$transaction(async (tx) => {
        const started = performance.now();
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '60s'`;
        await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
        const result = await calculate(tx);
        if (performance.now() - started >= CONSISTENT_READ_TIMEOUT_MS) {
          throw new Error('Snapshot consistent read exceeded its 60 second time limit.');
        }
        return result;
      }, { isolationLevel: 'RepeatableRead', timeout: CONSISTENT_READ_TIMEOUT_MS, maxWait: CONSISTENT_READ_MAX_WAIT_MS }))
      : await calculate(db);
    const metrics = typeof inputs === 'function' ? await inputs() : inputs;
    if (!metrics) {
      const outcome = await traceSnapshotPhase(trace, 'delete_missing_user', () => db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`
          SELECT "scope", "revision" FROM "performance_snapshot_revisions"
          WHERE "scope" IN ('global', ${ccmScope}) ORDER BY "scope" FOR UPDATE`;
        if (locked.length !== 2) throw new Error('Snapshot revision rows are missing during deletion.');
        const unchanged = locked.find((row) => row.scope === 'global')?.revision === globalRevision
          && locked.find((row) => row.scope === ccmScope)?.revision === ccmRevision;
        if (unchanged) {
          const deleted = await tx.crePerformanceSnapshot.deleteMany({
            where: { ...where, claimToken, status: 'refreshing', dirtyVersion },
          });
          if (deleted.count) return 'cre-not-in-ccm';
        }
        const dirty = await tx.crePerformanceSnapshot.updateMany({
          where: { ...where, claimToken, status: 'refreshing' },
          data: { status: 'dirty', dirtySince: new Date(), claimToken: null },
        });
        return dirty.count ? 'dirty' : 'superseded';
      }));
      trace.emit('attempt_result', { outcome });
      return { refreshed: false, reason: outcome };
    }
    const data = {
      callsThisMonth: metrics.callsThisMonth,
      assignedCustomerCount: metrics.assignedCustomerCount,
      pendingFollowUps: metrics.pendingFollowUps,
      dueServicesCount: metrics.dueServicesCount,
      missedWarrantyCount: metrics.missedWarrantyCount,
      details: metrics.details,
      cycleStartedAt: metrics.cycleStartedAt,
      asOf: metrics.asOf,
      computedAt: now,
      lastError: null,
      failureCount: 0,
    };
    const outcome = await traceSnapshotPhase(trace, 'persist_clean', () => db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT "scope", "revision" FROM "performance_snapshot_revisions"
        WHERE "scope" IN ('global', ${ccmScope}) ORDER BY "scope" FOR UPDATE`;
      if (locked.length !== 2) throw new Error('Snapshot revision rows are missing during publication.');
      const unchanged = locked.find((row) => row.scope === 'global')?.revision === globalRevision
        && locked.find((row) => row.scope === ccmScope)?.revision === ccmRevision;
      if (unchanged) {
        const clean = await tx.crePerformanceSnapshot.updateMany({
          where: { ...where, claimToken, status: 'refreshing', dirtyVersion },
          data: { ...data, status: 'ok', dirtySince: null, claimToken: null, globalRevision, ccmRevision },
        });
        if (clean.count) return 'ok';
      }
      const dirty = await tx.crePerformanceSnapshot.updateMany({
        where: { ...where, claimToken, status: 'refreshing' },
        data: { status: 'dirty', dirtySince: new Date(), claimToken: null },
      });
      return dirty.count ? 'dirty' : 'superseded';
    }));
    if (outcome === 'superseded') {
      trace.emit('attempt_result', { outcome });
      return { refreshed: false, reason: outcome };
    }
    // Cached summaries may still hold the previous snapshot (or a "pending" placeholder).
    invalidateCallListCache({ ccmIds: [key.ccmId], kinds: ['workflow'] });
    trace.emit('attempt_result', { outcome });
    return outcome === 'ok' ? { refreshed: true } : { refreshed: false, reason: 'dirty' };
  } catch (error) {
    trace.emit('attempt_result', { outcome: 'calculation_failed' });
    const failed = await traceSnapshotPhase(trace, 'persist_failure', () => db.crePerformanceSnapshot.updateMany({
      where: { ...where, claimToken, status: 'refreshing' },
      data: {
        status: 'failed',
        lastError: String(error?.message || error).slice(0, MAX_ERROR_LENGTH),
        failureCount: { increment: 1 },
        lastAttemptAt: now,
        claimToken: null,
      },
    }));
    if (!failed.count) return { refreshed: false, reason: 'superseded' };
    console.error(`Performance snapshot refresh failed for ${keyOf(key)}:`, error);
    return { refreshed: false, reason: 'failed', error };
  }
}

// Persist missing work before waking the bounded scheduler; API reads never wait for recalculation.
export function requestSnapshotRefresh(key, { db = prisma, signal = kickSnapshotRefresh } = {}) {
  const id = keyOf(key);
  if (requested.has(id)) return requested.get(id);
  const { creId, ccmId, year, month, viewer } = key;
  const request = Promise.resolve().then(() => db.crePerformanceSnapshot.createMany({
    data: [{ creId, ccmId, year, month, viewer }], skipDuplicates: true,
  })).then(() => {
    signal();
    return true;
  }).catch((error) => {
    console.error(`Performance snapshot request failed for ${id}:`, error);
    return false;
  })
    .finally(() => requested.delete(id));
  requested.set(id, request);
  return request;
}

export async function seedCurrentMonthSnapshots({ now = new Date(), db = prisma } = {}) {
  const { year, month } = workshopMonthOf(now);
  const [cres, freeServiceCres] = await Promise.all([
    db.user.findMany({
      where: { role: 'CRE', status: 'active', ccmId: { not: null } },
      select: { id: true, ccmId: true },
    }),
    db.user.findMany({
      where: { role: 'FREE_SERVICE_CRE', status: 'active', ccmId: { not: null } },
      select: { id: true, ccmId: true },
    }),
  ]);
  const data = [
    ...cres.flatMap((cre) => VIEWERS.map((viewer) => ({
      creId: cre.id, ccmId: cre.ccmId, year, month, viewer,
    }))),
    ...freeServiceCres.map((cre) => ({
      creId: cre.id, ccmId: cre.ccmId, year, month, viewer: 'FREE_SERVICE_CRE',
    })),
  ];
  if (!data.length) return 0;
  const result = await db.crePerformanceSnapshot.createMany({ data, skipDuplicates: true });
  return result.count;
}

export async function findSnapshotsDueForRefresh({ now = new Date(), limit = BATCH_SIZE, db = prisma } = {}) {
  const { year, month } = workshopMonthOf(now);
  const staleCurrent = new Date(now.getTime() - REFRESH_AFTER_MS);
  const staleHistorical = new Date(now.getTime() - HISTORICAL_SNAPSHOT_MAX_AGE_MS);
  const lockExpired = new Date(now.getTime() - REFRESH_LOCK_TIMEOUT_MS);
  const retryWindows = [
    { failureCount: { lte: 1 }, delay: 60 * 1000 },
    ...[2, 3, 4].map((failureCount) => ({ failureCount, delay: 60 * 1000 * 2 ** (failureCount - 1) })),
    { failureCount: { gte: 5 }, delay: SNAPSHOT_MAX_AGE_MS },
  ];
  const rows = await db.crePerformanceSnapshot.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'dirty'] } },
        { status: 'ok', year, month, computedAt: { lt: staleCurrent } },
        { status: 'ok', viewer: 'FREE_SERVICE_CRE', computedAt: { lt: staleCurrent } },
        { status: 'ok', NOT: { AND: [{ year }, { month }] }, computedAt: { lt: staleHistorical } },
        { status: 'failed', OR: [
          { lastAttemptAt: null },
          ...retryWindows.map(({ failureCount, delay }) => ({
            failureCount,
            lastAttemptAt: { lte: new Date(now.getTime() - delay) },
          })),
        ] },
        { status: 'refreshing', refreshStartedAt: { lt: lockExpired } },
      ],
    },
    orderBy: [
      { lastAttemptAt: { sort: 'asc', nulls: 'first' } },
      { computedAt: { sort: 'asc', nulls: 'first' } },
      { creId: 'asc' }, { ccmId: 'asc' }, { year: 'asc' }, { month: 'asc' }, { viewer: 'asc' },
    ],
    take: limit,
  });
  return rows;
}

export async function refreshDueSnapshots({ now = new Date(), db = prisma, refresh = refreshSnapshot } = {}) {
  const concurrency = snapshotRefreshConcurrency();
  await seedCurrentMonthSnapshots({ now, db });
  const due = await findSnapshotsDueForRefresh({ now, db });
  let refreshed = 0;
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const row = due[next++];
      try {
        const result = await refresh(row, { now: new Date(), db });
        if (result.refreshed) refreshed += 1;
      } catch (error) {
        console.error(`Performance snapshot batch refresh failed for ${keyOf(row)}:`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return { due: due.length, refreshed };
}

export async function tick({ refresh = refreshDueSnapshots } = {}) {
  if (ticking) return;
  ticking = true;
  try {
    await refresh();
  } catch (error) {
    console.error('Performance snapshot scheduler tick failed:', error);
  } finally {
    ticking = false;
  }
}

// Called after imports, reversals and ownership changes commit.
export function kickSnapshotRefresh() {
  if (!isPerformanceAggregateMaintenanceEnabled() || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    tick();
  }, KICK_DELAY_MS);
  kickTimer.unref?.();
}

setSnapshotRefreshHandler(kickSnapshotRefresh);

// Started once after the server is listening. Runs whenever write-side maintenance is on (including during
// backfill, while the read path is still off); it does nothing when both flags are off.
export function startPerformanceSnapshotScheduler() {
  if (schedulerTimer || !isPerformanceAggregateMaintenanceEnabled()) return false;
  snapshotRefreshConcurrency();
  schedulerTimer = setInterval(tick, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
  return true;
}

export function stopPerformanceSnapshotScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (kickTimer) clearTimeout(kickTimer);
  schedulerTimer = null;
  kickTimer = null;
}
