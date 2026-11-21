import { Prisma } from '@prisma/client';
import { creAssignmentLinksForVehiclesSql, creAssignmentLinksSql } from './creAssignmentSource.js';

// The projection is staging-only: application writers do not currently maintain it.
export async function reconcileCreAssignmentProjection(db, { vehicleIds } = {}) {
  if (vehicleIds !== undefined && (!Array.isArray(vehicleIds) || !vehicleIds.length
    || vehicleIds.length > 500 || vehicleIds.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error('Assignment projection reconciliation requires between 1 and 500 non-empty vehicle IDs.');
  }
  const expected = vehicleIds === undefined ? creAssignmentLinksSql : creAssignmentLinksForVehiclesSql(vehicleIds);
  const actual = vehicleIds === undefined
    ? Prisma.sql`SELECT * FROM "cre_vehicle_assignment_projection"`
    : Prisma.sql`SELECT * FROM "cre_vehicle_assignment_projection" WHERE "vehicleId" IN (${Prisma.join(vehicleIds)})`;
  const [counts] = await db.$queryRaw`
    WITH expected AS (${expected}), actual AS (${actual})
    SELECT
      COUNT(*) FILTER (WHERE p."vehicleId" IS NULL) AS missing,
      COUNT(*) FILTER (WHERE e."vehicleId" IS NULL) AS unexpected,
      COUNT(*) FILTER (WHERE e."vehicleId" IS NOT NULL AND p."vehicleId" IS NOT NULL
        AND (e."fromMaster" <> p."fromMaster" OR e."fromAllocation" <> p."fromAllocation")) AS changed
    FROM expected e
    FULL JOIN actual p
      ON p."ccmId" = e."ccmId" AND p."creId" = e."creId" AND p."vehicleId" = e."vehicleId"
  `;
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value.toString()]));
}

// Each page is a point-in-time comparison; pages do not share a snapshot across calls.
export async function reconcileCreAssignmentProjectionPage(db, { afterId = null, limit = 100 } = {}) {
  if (afterId !== null && (typeof afterId !== 'string' || !afterId.trim())) {
    throw new Error('Assignment projection reconciliation cursor must be a non-empty vehicle ID or null.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Assignment projection reconciliation page size must be an integer between 1 and 500.');
  }
  return db.$transaction(async (transaction) => {
    const vehicleCursor = afterId === null ? Prisma.empty : Prisma.sql`WHERE "id" > ${afterId}`;
    const projectionCursor = afterId === null ? Prisma.empty : Prisma.sql`WHERE "vehicleId" > ${afterId}`;
    const rows = await transaction.$queryRaw`
      WITH vehicle_page AS (
        SELECT "id" AS "vehicleId" FROM "vehicles" ${vehicleCursor}
        ORDER BY "id" LIMIT ${limit + 1}
      ), projection_page AS (
        SELECT DISTINCT "vehicleId" FROM "cre_vehicle_assignment_projection" ${projectionCursor}
        ORDER BY "vehicleId" LIMIT ${limit + 1}
      )
      SELECT "vehicleId" FROM (
        SELECT "vehicleId" FROM vehicle_page
        UNION
        SELECT "vehicleId" FROM projection_page
      ) candidates
      ORDER BY "vehicleId" LIMIT ${limit + 1}
    `;
    const vehicleIds = rows.slice(0, limit).map(({ vehicleId }) => vehicleId);
    const counts = vehicleIds.length
      ? await reconcileCreAssignmentProjection(transaction, { vehicleIds })
      : { missing: '0', unexpected: '0', changed: '0' };
    return {
      processed: vehicleIds.length,
      nextAfterId: vehicleIds.at(-1) ?? afterId,
      hasMore: rows.length > limit,
      counts,
    };
  }, { isolationLevel: 'RepeatableRead' });
}

// Experimental primitive only: every writer must lock all affected old and new vehicle IDs before
// any source mutation. The projection is not safe for reads until all writers and backfill comply.
export async function withCreAssignmentProjectionWrites(db, vehicleIds, mutate) {
  if (!Array.isArray(vehicleIds) || !vehicleIds.length
    || vehicleIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Assignment projection writes require non-empty vehicle IDs.');
  }
  if (typeof mutate !== 'function') throw new Error('Assignment projection writes require a mutation callback.');
  const ids = [...new Set(vehicleIds)].sort();
  return db.$transaction(async (transaction) => {
    for (const id of ids) {
      await transaction.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`cre-assignment-projection:${id}`}, 0))) AS projection_lock`;
    }
    const result = await mutate(transaction);
    await transaction.$executeRaw`
      DELETE FROM "cre_vehicle_assignment_projection"
      WHERE "vehicleId" IN (${Prisma.join(ids)})
    `;
    await transaction.$executeRaw`
      INSERT INTO "cre_vehicle_assignment_projection" ("ccmId", "creId", "vehicleId", "fromMaster", "fromAllocation")
      ${creAssignmentLinksForVehiclesSql(ids)}
    `;
    return result;
  }, { isolationLevel: 'ReadCommitted' });
}

// Experimental page primitive; callers may persist nextAfterId only after the returned promise resolves.
// Online correctness requires every assignment/vehicle writer to use the same lock before mutation.
export async function backfillCreAssignmentProjectionPage(db, { afterId = null, limit = 100 } = {}) {
  if (afterId !== null && (typeof afterId !== 'string' || !afterId.trim())) {
    throw new Error('Assignment projection backfill cursor must be a non-empty vehicle ID or null.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Assignment projection backfill page size must be an integer between 1 and 500.');
  }
  const vehicles = await db.vehicle.findMany({
    where: afterId === null ? {} : { id: { gt: afterId } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
  if (!vehicles.length) return { processed: 0, nextAfterId: afterId, hasMore: false };
  await withCreAssignmentProjectionWrites(db, vehicles.map(({ id }) => id), async () => {});
  return {
    processed: vehicles.length,
    nextAfterId: vehicles.at(-1).id,
    hasMore: vehicles.length === limit,
  };
}
