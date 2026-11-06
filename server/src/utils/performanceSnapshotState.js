import { workshopMonthOf } from './workshopTime.js';

export const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
// Past months are frozen to their month end, so they only need a periodic safety refresh.
export const HISTORICAL_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isPerformanceAggregatesEnabled(env = process.env) {
  return String(env.PERFORMANCE_AGGREGATES_ENABLED ?? '').trim().toLowerCase() === 'true';
}

// Write-side maintenance. Off by default so the application keeps working before the migration is applied.
// Rollout order: apply migration -> MAINTAIN=true -> run backfill -> ENABLED=true.
export function isPerformanceAggregateMaintenanceEnabled(env = process.env) {
  return isPerformanceAggregatesEnabled(env)
    || String(env.PERFORMANCE_AGGREGATES_MAINTAIN ?? '').trim().toLowerCase() === 'true';
}

// Marks snapshots stale. Accepts a transaction or the main client, so ownership changes can do it atomically.
// By default only the current month is flagged; `allMonths` also covers frozen historical months (needed when
// a CRE's service permissions change). Omit creIds and ccmIds to mark everything (imports without a known scope).
export async function markCreSnapshotsDirty(db, { creIds, ccmIds, allMonths = false, now = new Date() } = {}) {
  const { year, month } = workshopMonthOf(now);
  const scope = {
    ...(allMonths ? {} : { year, month }),
    ...(creIds?.length ? { creId: { in: creIds } } : {}),
    ...(ccmIds?.length ? { ccmId: { in: ccmIds } } : {}),
  };
  const result = await db.crePerformanceSnapshot.updateMany({
    where: { ...scope, status: { in: ['ok', 'failed'] } },
    data: { status: 'dirty', dirtySince: now },
  });
  // A refresh already in flight may have read the data before this change, so it must not clear the flag.
  await db.crePerformanceSnapshot.updateMany({
    where: { ...scope, status: 'refreshing' },
    data: { dirtySince: now },
  });
  return result.count;
}

// A snapshot is never reported as current when it is dirty, failed, still being refreshed or too old.
export function describeSnapshot(row, { now = new Date(), isCurrentMonth = true } = {}) {
  if (!row) {
    return { status: 'pending', isStale: true, computedAt: null, asOf: null, lastError: row?.lastError ?? null };
  }
  if (!row.computedAt) {
    return {
      status: row.status || 'pending',
      isStale: true,
      computedAt: null,
      asOf: null,
      lastError: row.status === 'failed' ? row.lastError ?? null : null,
    };
  }
  const maxAge = isCurrentMonth ? SNAPSHOT_MAX_AGE_MS : HISTORICAL_SNAPSHOT_MAX_AGE_MS;
  const tooOld = now.getTime() - row.computedAt.getTime() > maxAge;
  const flagged = row.status !== 'ok' || Boolean(row.dirtySince);
  const status = row.status === 'ok' && tooOld ? 'stale' : row.status;
  return {
    status,
    isStale: flagged || tooOld,
    computedAt: row.computedAt,
    asOf: row.asOf,
    lastError: row.status === 'failed' ? row.lastError : null,
  };
}
