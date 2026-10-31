import { recordCreAssignmentEvent } from './creAssignmentHistory.js';

export function selectLeastLoadedCre(creIds, workloads) {
  let selected = null;
  for (const creId of creIds) {
    const workload = workloads.get(creId) || 0;
    if (!selected || workload < (workloads.get(selected) || 0)) {
      selected = creId;
    }
  }
  return selected;
}

export function selectNextCre(creIds, workloads, assignmentsThisBatch, perCreBatchLimit = Infinity) {
  const availableCreIds = creIds.filter((id) => (assignmentsThisBatch.get(id) || 0) < perCreBatchLimit);
  return selectLeastLoadedCre(availableCreIds, workloads);
}

export async function lockCcmAllocationTeam(transaction, ccmId) {
  await transaction.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`customer-allocation:${ccmId}`}, 0))) AS allocation_lock`;
}

export async function lockCcmAllocationTeams(transaction, ccmIds) {
  const sortedCcmIds = [...new Set(ccmIds.filter(Boolean).map(String))].sort();
  for (const ccmId of sortedCcmIds) {
    await lockCcmAllocationTeam(transaction, ccmId);
  }
}

export async function lockAndValidateCreCcmTransfer(transaction, {
  creId,
  expectedOldCcmId,
  newCcmId,
}) {
  await lockCcmAllocationTeams(transaction, [expectedOldCcmId, newCcmId]);
  const cre = await transaction.user.findUnique({
    where: { id: creId },
    select: { id: true, role: true, ccmId: true, status: true },
  });
  if (!cre || !['CRE', 'FREE_SERVICE_CRE'].includes(cre.role)
    || cre.ccmId !== expectedOldCcmId || cre.status !== 'active') {
    return { error: 'cre-changed' };
  }
  const targetCcm = await transaction.user.findFirst({
    where: { role: 'CCM', status: 'active', ccmId: newCcmId },
    select: { ccmId: true },
  });
  if (!targetCcm) return { error: 'ccm-inactive' };
  if (expectedOldCcmId === newCcmId) return { cre };

  const [activeAllocation, assignedCustomer] = await Promise.all([
    transaction.allocation.findFirst({
      where: { creId, status: 'assigned' },
      select: { id: true },
    }),
    transaction.masterCallList.findFirst({
      where: { ownerUserId: creId },
      select: { id: true },
    }),
  ]);
  if (activeAllocation || assignedCustomer) return { error: 'active-assignments' };
  return { cre };
}

async function loadWorkloads(transaction, ccmId, activeCreIds) {
  const [masterEntries, allocations] = await Promise.all([
    transaction.masterCallList.findMany({
      where: { ccmId, ownerUserId: { in: activeCreIds } },
      select: { ownerUserId: true, vin: true },
    }),
    transaction.allocation.findMany({
      where: { ccmId, status: 'assigned', creId: { in: activeCreIds } },
      select: { creId: true, vehicle: { select: { id: true, vin: true } } },
    }),
  ]);
  const workloads = new Map(activeCreIds.map((id) => [id, 0]));
  const masterVins = new Set();
  for (const entry of masterEntries) {
    workloads.set(entry.ownerUserId, (workloads.get(entry.ownerUserId) || 0) + 1);
    masterVins.add(entry.vin);
  }

  const countedAllocationVehicles = new Set();
  for (const allocation of allocations) {
    const vehicle = allocation.vehicle;
    if (masterVins.has(vehicle.vin) || countedAllocationVehicles.has(vehicle.id)) continue;
    countedAllocationVehicles.add(vehicle.id);
    workloads.set(allocation.creId, (workloads.get(allocation.creId) || 0) + 1);
  }
  return workloads;
}

export async function allocateUnassignedMasterCallListEntries(
  transaction,
  ccmId,
  actorId = null,
  { spreadAcrossTeam = false, onBeforeMutation, onMutation } = {},
) {
  const applyMutation = async (change, update) => {
    if (onMutation) return onMutation(change, update);
    await onBeforeMutation?.(change);
    return update();
  };
  await lockCcmAllocationTeam(transaction, ccmId);
  const activeCres = await transaction.user.findMany({
    where: { role: 'CRE', status: 'active', ccmId },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!activeCres.length) return 0;
  const activeCreIds = activeCres.map(({ id }) => id);

  const unassigned = await transaction.masterCallList.findMany({
    where: { ccmId, ownerUserId: null, assignmentNeedsReview: false, vehicle: { isNot: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, vin: true, updatedAt: true, vehicle: { select: { id: true } } },
  });
  if (!unassigned.length) return 0;

  const vins = [...new Set(unassigned.map(({ vin }) => vin))];
  const existingAllocations = await transaction.allocation.findMany({
    where: {
      ccmId,
      status: 'assigned',
      creId: { in: activeCreIds },
      vehicle: { is: { vin: { in: vins } } },
    },
    select: { id: true, vehicleId: true, creId: true, updatedAt: true, vehicle: { select: { vin: true } } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const allocationOwnerByVin = new Map();
  for (const allocation of existingAllocations) {
    if (!allocationOwnerByVin.has(allocation.vehicle.vin)) allocationOwnerByVin.set(allocation.vehicle.vin, allocation);
  }

  for (const entry of unassigned) {
    const allocation = allocationOwnerByVin.get(entry.vin);
    if (!allocation) continue;
    await applyMutation({
      entityType: 'MasterCallList',
      entityId: entry.id,
      ccmId,
      before: { ownerUserId: null, updatedAt: entry.updatedAt },
      after: { ownerUserId: allocation.creId },
    }, () => transaction.masterCallList.update({ where: { id: entry.id }, data: { ownerUserId: allocation.creId } }));
    await recordCreAssignmentEvent(transaction, {
      vehicleId: entry.vehicle.id,
      masterCallListId: entry.id,
      ccmId,
      newCreId: allocation.creId,
      actorUserId: actorId,
      eventType: 'AUTO_ASSIGNED',
    });
    await transaction.auditLog.create({
      data: {
        userId: actorId,
        entityType: 'MasterCallList',
        entityId: entry.id,
        action: 'CRE_ASSIGNMENT_SYNCED',
        details: JSON.stringify({ ccmId, creId: allocation.creId, source: 'existing-allocation' }),
      },
    });
  }

  const remaining = unassigned.filter(({ vin }) => !allocationOwnerByVin.has(vin));
  const workloads = await loadWorkloads(transaction, ccmId, activeCreIds);
  const assignmentsThisBatch = new Map(activeCreIds.map((id) => [id, 0]));
  const perCreBatchLimit = spreadAcrossTeam && activeCreIds.length > 1
    ? Math.ceil(remaining.length / 2)
    : Infinity;
  let assignedCount = 0;
  for (const entry of remaining) {
    const creId = selectNextCre(activeCreIds, workloads, assignmentsThisBatch, perCreBatchLimit);
    if (!creId) break;
    await applyMutation({
      entityType: 'MasterCallList',
      entityId: entry.id,
      ccmId,
      before: { ownerUserId: null, updatedAt: entry.updatedAt },
      after: { ownerUserId: creId },
    }, () => transaction.masterCallList.update({ where: { id: entry.id }, data: { ownerUserId: creId } }));
    const allocations = await transaction.allocation.findMany({
      where: { ccmId, status: 'assigned', vehicle: { is: { vin: entry.vin } } },
      select: { id: true, vehicleId: true, creId: true, updatedAt: true },
    });
    for (const allocation of allocations) {
      if (allocation.creId !== creId) {
        await applyMutation({
          entityType: 'Allocation',
          entityId: allocation.id,
          ccmId,
          before: { creId: allocation.creId, updatedAt: allocation.updatedAt },
          after: { creId },
        }, () => transaction.allocation.update({ where: { id: allocation.id }, data: { creId } }));
        await recordCreAssignmentEvent(transaction, {
          vehicleId: allocation.vehicleId,
          allocationId: allocation.id,
          ccmId,
          previousCreId: allocation.creId,
          newCreId: creId,
          actorUserId: actorId,
          eventType: 'AUTO_ASSIGNED',
        });
      }
    }
    await recordCreAssignmentEvent(transaction, {
      vehicleId: entry.vehicle.id,
      masterCallListId: entry.id,
      ccmId,
      newCreId: creId,
      actorUserId: actorId,
      eventType: 'AUTO_ASSIGNED',
    });
    await transaction.auditLog.create({
      data: {
        userId: actorId,
        entityType: 'MasterCallList',
        entityId: entry.id,
        action: 'CRE_AUTO_ASSIGNED',
        details: JSON.stringify({ ccmId, creId }),
      },
    });
    workloads.set(creId, (workloads.get(creId) || 0) + 1);
    assignmentsThisBatch.set(creId, (assignmentsThisBatch.get(creId) || 0) + 1);
    assignedCount += 1;
  }
  return assignedCount;
}

export async function redistributeCreAssignments(transaction, { ccmId, departingCreId, actorId = null }) {
  await lockCcmAllocationTeam(transaction, ccmId);
  const activeCres = await transaction.user.findMany({
    where: { role: 'CRE', status: 'active', ccmId, id: { not: departingCreId } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const activeCreIds = activeCres.map(({ id }) => id);
  const entries = await transaction.masterCallList.findMany({
    where: { ccmId, ownerUserId: departingCreId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, vin: true, vehicle: { select: { id: true } } },
  });
  const allocationRows = await transaction.allocation.findMany({
    where: { ccmId, creId: departingCreId, status: 'assigned' },
    select: { id: true, vehicleId: true, vehicle: { select: { vin: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const masterVins = new Set(entries.map(({ vin }) => vin));
  const allocationOnly = [];
  const seenVehicleIds = new Set();
  for (const allocation of allocationRows) {
    if (masterVins.has(allocation.vehicle.vin) || seenVehicleIds.has(allocation.vehicleId)) continue;
    seenVehicleIds.add(allocation.vehicleId);
    allocationOnly.push(allocation);
  }

  const changes = [];
  if (!activeCreIds.length) {
    for (const entry of entries) {
      await transaction.masterCallList.update({
        where: { id: entry.id },
        data: { ownerUserId: null, status: 'pending', assignmentNeedsReview: true },
      });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: entry.vehicle.id,
        masterCallListId: entry.id,
        ccmId,
        previousCreId: departingCreId,
        actorUserId: actorId,
      });
      changes.push({ masterCallListId: entry.id, vin: entry.vin, from: departingCreId, to: null });
    }
    for (const allocation of allocationRows) {
      await transaction.allocation.update({
        where: { id: allocation.id },
        data: { creId: null },
      });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: allocation.vehicleId,
        allocationId: allocation.id,
        ccmId,
        previousCreId: departingCreId,
        actorUserId: actorId,
      });
      changes.push({ allocationId: allocation.id, vin: allocation.vehicle.vin, from: departingCreId, to: null });
    }
  } else {
    const workloads = await loadWorkloads(transaction, ccmId, activeCreIds);
    for (const entry of entries) {
      const creId = selectLeastLoadedCre(activeCreIds, workloads);
      if (!creId) break;
      await transaction.masterCallList.update({ where: { id: entry.id }, data: { ownerUserId: creId } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: entry.vehicle.id,
        masterCallListId: entry.id,
        ccmId,
        previousCreId: departingCreId,
        newCreId: creId,
        actorUserId: actorId,
      });
      const linkedAllocations = allocationRows.filter(({ vehicle }) => vehicle.vin === entry.vin);
      for (const allocation of linkedAllocations) {
        await transaction.allocation.update({
          where: { id: allocation.id },
          data: { creId },
        });
        await recordCreAssignmentEvent(transaction, {
          vehicleId: allocation.vehicleId,
          allocationId: allocation.id,
          ccmId,
          previousCreId: departingCreId,
          newCreId: creId,
          actorUserId: actorId,
        });
      }
      changes.push({ masterCallListId: entry.id, vin: entry.vin, from: departingCreId, to: creId });
      workloads.set(creId, (workloads.get(creId) || 0) + 1);
    }
    for (const allocation of allocationOnly) {
      const creId = selectLeastLoadedCre(activeCreIds, workloads);
      if (!creId) break;
      await transaction.allocation.update({ where: { id: allocation.id }, data: { creId } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: allocation.vehicleId,
        allocationId: allocation.id,
        ccmId,
        previousCreId: departingCreId,
        newCreId: creId,
        actorUserId: actorId,
      });
      changes.push({ allocationId: allocation.id, vin: allocation.vehicle.vin, from: departingCreId, to: creId });
      workloads.set(creId, (workloads.get(creId) || 0) + 1);
    }
  }

  await transaction.auditLog.create({
    data: {
      userId: actorId,
      entityType: 'User',
      entityId: departingCreId,
      action: activeCreIds.length ? 'CRE_CUSTOMERS_REDISTRIBUTED' : 'CRE_CUSTOMERS_UNASSIGNED',
      details: JSON.stringify({
        ccmId,
        masterCallListEntries: entries.length,
        allocationOnlyVehicles: allocationOnly.length,
        reassignedTo: activeCreIds,
        changes,
      }),
    },
  });
  return entries.length + allocationOnly.length;
}

export async function unassignCreAssignments(transaction, { ccmId, departingCreId, actorId = null, reason = null }) {
  if (!ccmId) {
    const [entryTeams, allocationTeams] = await Promise.all([
      transaction.masterCallList.findMany({
        where: { ownerUserId: departingCreId },
        distinct: ['ccmId'],
        select: { ccmId: true },
      }),
      transaction.allocation.findMany({
        where: { creId: departingCreId, status: 'assigned' },
        distinct: ['ccmId'],
        select: { ccmId: true },
      }),
    ]);
    const ccmIds = [...new Set([...entryTeams, ...allocationTeams]
      .map(({ ccmId: teamId }) => teamId)
      .filter(Boolean))].sort();
    let unassignedCount = 0;
    for (const teamId of ccmIds) {
      unassignedCount += await unassignCreAssignments(transaction, {
        ccmId: teamId,
        departingCreId,
        actorId,
        reason,
      });
    }
    return unassignedCount;
  }

  await lockCcmAllocationTeam(transaction, ccmId);
  const [entries, allocations] = await Promise.all([
    transaction.masterCallList.findMany({
      where: { ccmId, ownerUserId: departingCreId },
      select: { id: true, vehicle: { select: { id: true } } },
    }),
    transaction.allocation.findMany({
      where: { ccmId, creId: departingCreId, status: 'assigned' },
      select: { id: true, vehicleId: true },
    }),
  ]);
  for (const entry of entries) {
    await transaction.masterCallList.update({
      where: { id: entry.id },
      data: { ownerUserId: null, status: 'pending', assignmentNeedsReview: true },
    });
    await recordCreAssignmentEvent(transaction, {
      vehicleId: entry.vehicle.id,
      masterCallListId: entry.id,
      ccmId,
      previousCreId: departingCreId,
      actorUserId: actorId,
      reason,
      eventType: 'DEACTIVATED',
    });
  }
  for (const allocation of allocations) {
    await transaction.allocation.update({
      where: { id: allocation.id },
      data: { creId: null },
    });
    await recordCreAssignmentEvent(transaction, {
      vehicleId: allocation.vehicleId,
      allocationId: allocation.id,
      ccmId,
      previousCreId: departingCreId,
      actorUserId: actorId,
      reason,
      eventType: 'DEACTIVATED',
    });
  }
  await transaction.auditLog.create({
    data: {
      userId: actorId,
      entityType: 'User',
      entityId: departingCreId,
      action: 'CRE_ASSIGNMENTS_UNASSIGNED',
      details: JSON.stringify({ ccmId, masterCallListEntries: entries.length, allocations: allocations.length }),
    },
  });
  return entries.length + allocations.length;
}

export async function repairFreeServiceCreAssignments(transaction, actorId = null) {
  const users = await transaction.user.findMany({
    where: { role: 'FREE_SERVICE_CRE' },
    select: { id: true },
  });
  let repaired = 0;
  for (const user of users) {
    const [masterTeams, allocationTeams] = await Promise.all([
      transaction.masterCallList.findMany({
        where: { ownerUserId: user.id },
        distinct: ['ccmId'],
        select: { ccmId: true },
      }),
      transaction.allocation.findMany({
        where: { creId: user.id, status: 'assigned' },
        distinct: ['ccmId'],
        select: { ccmId: true },
      }),
    ]);
    const teams = new Set([...masterTeams, ...allocationTeams].map((row) => row.ccmId).filter(Boolean));
    for (const ccmId of teams) {
      repaired += await redistributeCreAssignments(transaction, {
        ccmId,
        departingCreId: user.id,
        actorId,
      });
    }
  }
  return repaired;
}
