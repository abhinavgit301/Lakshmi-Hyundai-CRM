import { prisma } from '../config/prisma.js';
import {
  computeCrePerformanceMetrics,
  computeFreeServiceCrePerformanceMetrics,
} from '../controllers/callWorkflowController.js';
import { workshopMonthOf } from '../utils/workshopTime.js';
import { invalidateCallListCache } from '../utils/callListCache.js';
import { setSnapshotRefreshHandler } from '../utils/performanceRefreshSignal.js';
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
const MAX_ERROR_LENGTH = 500;

const VIEWERS = ['CRE', 'CCM'];
const requested = new Set();
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

function backoffMs(failureCount) {
  return Math.min(60 * 1000 * 2 ** Math.max(failureCount - 1, 0), SNAPSHOT_MAX_AGE_MS);
}

// Recalculates one snapshot. A failure records the error and keeps the last good values.
export async function refreshSnapshot(key, {
  now = new Date(),
  db = prisma,
  compute = computeCrePerformanceMetrics,
  computeFreeService = computeFreeServiceCrePerformanceMetrics,
} = {}) {
  const where = {
    creId: key.creId, ccmId: key.ccmId, year: key.year, month: key.month, viewer: key.viewer,
  };
  await db.crePerformanceSnapshot.createMany({ data: [{ ...where }], skipDuplicates: true });
  const claimed = await db.crePerformanceSnapshot.updateMany({
    where: {
      ...where,
      OR: [
        { status: { not: 'refreshing' } },
        { refreshStartedAt: { lt: new Date(now.getTime() - REFRESH_LOCK_TIMEOUT_MS) } },
      ],
    },
    data: { status: 'refreshing', refreshStartedAt: now, lastAttemptAt: now },
  });
  if (!claimed.count) return { refreshed: false, reason: 'already-refreshing' };

  try {
    const expectedRole = key.viewer === 'FREE_SERVICE_CRE' ? 'FREE_SERVICE_CRE' : 'CRE';
    const user = await db.user.findFirst({
      where: { id: key.creId, role: expectedRole },
      select: { id: true, name: true, ccmId: true, freeServiceEnabled: true, warrantyEnabled: true },
    });
    if (!user || user.ccmId !== key.ccmId) {
      await db.crePerformanceSnapshot.deleteMany({ where });
      return { refreshed: false, reason: 'cre-not-in-ccm' };
    }
    const metrics = key.viewer === 'FREE_SERVICE_CRE'
      ? await computeFreeService({ targetCre: user, year: key.year, month: key.month, now, db })
      : await compute({ targetCre: user, viewer: key.viewer, year: key.year, month: key.month, now });
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
    // A change that landed while this refresh was calculating must stay flagged as dirty.
    const clean = await db.crePerformanceSnapshot.updateMany({
      where: { ...where, OR: [{ dirtySince: null }, { dirtySince: { lte: now } }] },
      data: { ...data, status: 'ok', dirtySince: null },
    });
    if (!clean.count) {
      await db.crePerformanceSnapshot.updateMany({ where, data: { ...data, status: 'dirty' } });
    }
    // Cached summaries may still hold the previous snapshot (or a "pending" placeholder).
    invalidateCallListCache({ ccmIds: [key.ccmId], kinds: ['workflow'] });
    return { refreshed: true };
  } catch (error) {
    const current = await db.crePerformanceSnapshot.findUnique({ where: snapshotWhere(key) });
    await db.crePerformanceSnapshot.updateMany({
      where,
      data: {
        status: 'failed',
        lastError: String(error?.message || error).slice(0, MAX_ERROR_LENGTH),
        failureCount: (current?.failureCount ?? 0) + 1,
        lastAttemptAt: now,
      },
    });
    console.error(`Performance snapshot refresh failed for ${keyOf(key)}:`, error);
    return { refreshed: false, reason: 'failed', error };
  }
}

// Reads never wait for a recalculation: a missing snapshot is queued and the caller reports "pending".
export function requestSnapshotRefresh(key) {
  const id = keyOf(key);
  if (requested.has(id)) return;
  requested.add(id);
  setImmediate(() => {
    refreshSnapshot(key)
      .catch((error) => console.error('Performance snapshot request failed:', error))
      .finally(() => requested.delete(id));
  });
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
  const rows = await db.crePerformanceSnapshot.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'dirty'] } },
        { status: 'ok', year, month, computedAt: { lt: staleCurrent } },
        { status: 'ok', viewer: 'FREE_SERVICE_CRE', computedAt: { lt: staleCurrent } },
        { status: 'ok', NOT: { AND: [{ year }, { month }] }, computedAt: { lt: staleHistorical } },
        { status: 'failed' },
        { status: 'refreshing', refreshStartedAt: { lt: lockExpired } },
      ],
    },
    orderBy: [{ status: 'asc' }, { computedAt: 'asc' }],
    take: limit * 3,
  });
  return rows
    .filter((row) => row.status !== 'failed'
      || !row.lastAttemptAt
      || now.getTime() - row.lastAttemptAt.getTime() >= backoffMs(row.failureCount))
    .slice(0, limit);
}

export async function refreshDueSnapshots({ now = new Date() } = {}) {
  await seedCurrentMonthSnapshots({ now });
  const due = await findSnapshotsDueForRefresh({ now });
  let refreshed = 0;
  for (const row of due) {
    const result = await refreshSnapshot(row, { now: new Date() });
    if (result.refreshed) refreshed += 1;
  }
  return { due: due.length, refreshed };
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshDueSnapshots();
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
