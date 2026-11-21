import { creAssignmentLinksSql } from './creAssignmentSource.js';

// Read-only inventory of the two sources used by creVehicleWhere. It deliberately does not
// depend on user status: authentication checks that separately from vehicle ownership.
export async function readCreAssignmentInventory(db) {
  const [inventory] = await db.$queryRaw`
    WITH links AS (${creAssignmentLinksSql}),
    customers AS (
      SELECT DISTINCT links."ccmId", links."creId", v."customerId"
      FROM links JOIN "vehicles" v ON v."id" = links."vehicleId"
    )
    SELECT
      (SELECT COUNT(*) FROM links) AS "vehicleLinks",
      (SELECT COUNT(*) FROM customers) AS "customerLinks",
      (SELECT COUNT(*) FROM links WHERE "fromMaster" AND NOT "fromAllocation") AS "masterOnly",
      (SELECT COUNT(*) FROM links WHERE "fromAllocation" AND NOT "fromMaster") AS "allocationOnly",
      (SELECT COUNT(*) FROM links WHERE "fromMaster" AND "fromAllocation") AS "bothSources",
      (SELECT COUNT(*) FROM "master_call_lists" m
       WHERE m."ownerUserId" IS NOT NULL AND m."vehicleId" IS NULL) AS "ownedUnlinkedMasterEntries",
      (SELECT COUNT(*) FROM "allocations" a
       JOIN "vehicles" v ON v."id" = a."vehicleId"
       WHERE a."status" = 'assigned' AND a."creId" IS NOT NULL AND a."ccmId" <> v."ccmId") AS "crossTeamActiveAllocations"
  `;
  return Object.fromEntries(Object.entries(inventory).map(([key, value]) => [key, value.toString()]));
}
