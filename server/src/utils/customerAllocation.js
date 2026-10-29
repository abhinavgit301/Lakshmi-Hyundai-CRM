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
    where: { ccmId, ownerUserId: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, vin: true, updatedAt: true },
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
    select: { creId: true, updatedAt: true, vehicle: { select: { vin: true } } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const allocationOwnerByVin = new Map();
  for (const allocation of existingAllocations) {
    if (!allocationOwnerByVin.has(allocation.vehicle.vin)) allocationOwnerByVin.set(allocation.vehicle.vin, allocation.creId);
  }

  for (const entry of unassigned) {
    const creId = allocationOwnerByVin.get(entry.vin);
    if (!creId) continue;
    await applyMutation({
      entityType: 'MasterCallList',
      entityId: entry.id,
      ccmId,
      before: { ownerUserId: null, updatedAt: entry.updatedAt },
      after: { ownerUserId: creId },
    }, () => transaction.masterCallList.update({ where: { id: entry.id }, data: { ownerUserId: creId } }));
    await transaction.auditLog.create({
      data: {
        userId: actorId,
        entityType: 'MasterCallList',
        entityId: entry.id,
        action: 'CRE_ASSIGNMENT_SYNCED',
        details: JSON.stringify({ ccmId, creId, source: 'existing-allocation' }),
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
      select: { id: true, creId: true, updatedAt: true },
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
      }
    }
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
    select: { id: true, vin: true },
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
    if (entries.length) {
      await transaction.masterCallList.updateMany({
        where: { ccmId, ownerUserId: departingCreId },
        data: { ownerUserId: null, status: 'pending' },
      });
      for (const entry of entries) changes.push({ masterCallListId: entry.id, vin: entry.vin, from: departingCreId, to: null });
    }
    if (allocationRows.length) {
      await transaction.allocation.updateMany({
        where: { ccmId, creId: departingCreId, status: 'assigned' },
        data: { creId: null },
      });
      for (const allocation of allocationRows) {
        changes.push({ allocationId: allocation.id, vin: allocation.vehicle.vin, from: departingCreId, to: null });
      }
    }
  } else {
    const workloads = await loadWorkloads(transaction, ccmId, activeCreIds);
    for (const entry of entries) {
      const creId = selectLeastLoadedCre(activeCreIds, workloads);
      if (!creId) break;
      await transaction.masterCallList.update({ where: { id: entry.id }, data: { ownerUserId: creId } });
      await transaction.allocation.updateMany({
        where: { ccmId, status: 'assigned', vehicle: { is: { vin: entry.vin } } },
        data: { creId },
      });
      changes.push({ masterCallListId: entry.id, vin: entry.vin, from: departingCreId, to: creId });
      workloads.set(creId, (workloads.get(creId) || 0) + 1);
    }
    for (const allocation of allocationOnly) {
      const creId = selectLeastLoadedCre(activeCreIds, workloads);
      if (!creId) break;
      await transaction.allocation.update({ where: { id: allocation.id }, data: { creId } });
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
