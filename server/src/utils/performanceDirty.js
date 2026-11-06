import { prisma } from '../config/prisma.js';
import { isPerformanceAggregateMaintenanceEnabled, markCreSnapshotsDirty } from './performanceSnapshotState.js';
import { kickSnapshotRefresh } from '../services/performanceSnapshotService.js';

// Writes that change source records behind the snapshot metrics: imports and their reversals, allocations
// and ownership, call-list entries and customers. Call logs, follow-ups and appointments are not listed:
// they are covered by the 15-minute refresh, and flagging them would refresh a CRE after every call.
const SNAPSHOT_SOURCE_WRITES = /^\/api\/v1\/(imports|ccms\/[^/]+\/monthly-customer-data(?!\/preview)|allocations|users|call-list|customers)(\/|$)/;

export function performanceDirtyMiddleware(req, res, next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && SNAPSHOT_SOURCE_WRITES.test(req.originalUrl.split('?')[0])) {
    res.on('finish', () => {
      if (res.statusCode >= 400 || !isPerformanceAggregateMaintenanceEnabled()) return;
      const ccmIds = res.locals?.cacheInvalidation?.ccmIds;
      const scope = Array.isArray(ccmIds) && ccmIds.length && ccmIds.every(Boolean) ? { ccmIds } : {};
      markCreSnapshotsDirty(prisma, scope)
        .then(() => kickSnapshotRefresh())
        .catch((error) => console.error('Failed to flag performance snapshots as dirty:', error));
    });
  }
  next();
}
