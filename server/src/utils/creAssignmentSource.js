import { Prisma } from '@prisma/client';

// Exact vehicle grant sources used by creVehicleWhere. The vehicle's CCM must match each source.
function assignmentSourceSql(masterFilter = Prisma.empty, allocationFilter = Prisma.empty) {
  return Prisma.sql`
  SELECT m."ccmId", m."ownerUserId" AS "creId", m."vehicleId", TRUE AS master, FALSE AS allocation
  FROM "master_call_lists" m
  JOIN "vehicles" v ON v."id" = m."vehicleId" AND v."ccmId" = m."ccmId"
  WHERE m."ownerUserId" IS NOT NULL ${masterFilter}
  UNION ALL
  SELECT a."ccmId", a."creId", a."vehicleId", FALSE, TRUE
  FROM "allocations" a
  JOIN "vehicles" v ON v."id" = a."vehicleId" AND v."ccmId" = a."ccmId"
  WHERE a."status" = 'assigned' AND a."creId" IS NOT NULL ${allocationFilter}
`;
}

function assignmentLinksSql(source) {
  return Prisma.sql`
  SELECT "ccmId", "creId", "vehicleId", BOOL_OR(master) AS "fromMaster", BOOL_OR(allocation) AS "fromAllocation"
  FROM (${source}) grants
  GROUP BY "ccmId", "creId", "vehicleId"
`;
}

export const creAssignmentSourceSql = assignmentSourceSql();
export const creAssignmentLinksSql = assignmentLinksSql(creAssignmentSourceSql);

export function creAssignmentLinksForVehiclesSql(vehicleIds) {
  if (!vehicleIds.length) throw new Error('Assignment projection requires at least one vehicle ID.');
  const ids = Prisma.join(vehicleIds);
  return assignmentLinksSql(assignmentSourceSql(
    Prisma.sql`AND m."vehicleId" IN (${ids})`,
    Prisma.sql`AND a."vehicleId" IN (${ids})`,
  ));
}
