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
    || cre.ccmId !== expectedOldCcmId) {
    return { error: 'cre-changed' };
  }
  const targetCcm = await transaction.user.findFirst({
    where: { role: 'CCM', status: 'active', ccmId: newCcmId },
    select: { ccmId: true },
  });
  if (!targetCcm) return { error: 'ccm-inactive' };
  if (expectedOldCcmId === newCcmId) return { cre };

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

  const [unassignedCandidates, pendingEntries, pendingAllocations] = await Promise.all([
    transaction.masterCallList.findMany({
      where: { ccmId, ownerUserId: null, assignmentNeedsReview: false, vehicle: { isNot: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, vin: true, updatedAt: true, vehicle: { select: { id: true } } },
    }),
    transaction.masterCallList.findMany({
      where: { ccmId, assignmentNeedsReview: true },
      select: { vin: true },
    }),
    transaction.allocation.findMany({
      where: { ccmId, status: 'assigned', assignmentNeedsReview: true },
      select: { vehicle: { select: { vin: true } } },
    }),
  ]);
  const pendingVins = new Set(pendingEntries.map(({ vin }) => vin));
  for (const allocation of pendingAllocations) pendingVins.add(allocation.vehicle.vin);
  const unassigned = unassignedCandidates.filter(({ vin }) => !pendingVins.has(vin));
  if (!unassigned.length) return 0;

  const vins = [...new Set(unassigned.map(({ vin }) => vin))];
  const existingAllocations = await transaction.allocation.findMany({
    where: {
      ccmId,
      status: 'assigned',
      assignmentNeedsReview: false,
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
      where: {
        ccmId,
        status: 'assigned',
        assignmentNeedsReview: false,
        vehicle: { is: { vin: entry.vin } },
      },
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

export async function getPendingCreRedistribution(transaction, ccmId) {
  const [entries, allocations, activeCreCount] = await Promise.all([
    transaction.masterCallList.findMany({
      where: { ccmId, ownerUserId: null, assignmentNeedsReview: true, vehicle: { isNot: null } },
      select: { vin: true },
    }),
    transaction.allocation.findMany({
      where: { ccmId, creId: null, status: 'assigned', assignmentNeedsReview: true },
      select: { vehicle: { select: { vin: true } } },
    }),
    transaction.user.count({ where: { role: 'CRE', status: 'active', ccmId } }),
  ]);
  const vins = new Set(entries.map(({ vin }) => vin));
  for (const allocation of allocations) vins.add(allocation.vehicle.vin);
  return {
    pendingCustomers: vins.size,
    pendingMasterCallListEntries: entries.length,
    pendingAllocationRecords: allocations.length,
    activeCreCount,
  };
}

export async function allocatePendingCreRedistribution(transaction, { ccmId, actorId = null }) {
  await lockCcmAllocationTeam(transaction, ccmId);
  const pending = await getPendingCreRedistribution(transaction, ccmId);
  const activeCres = await transaction.user.findMany({
    where: { role: 'CRE', status: 'active', ccmId },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!activeCres.length || !pending.pendingCustomers) {
    return { assignedCustomers: 0, ...pending, activeCreCount: activeCres.length };
  }
  const activeCreIds = activeCres.map(({ id }) => id);
  const entries = await transaction.masterCallList.findMany({
    where: { ccmId, ownerUserId: null, assignmentNeedsReview: true, vehicle: { isNot: null } },
    select: { id: true, vin: true, vehicle: { select: { id: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const queuedEntries = await transaction.masterCallList.findMany({
    where: { ccmId, ownerUserId: null, assignmentNeedsReview: true, vehicle: { isNot: null } },
    select: { id: true, vin: true, vehicle: { select: { id: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const queueVins = new Set(queuedEntries.map(({ vin }) => vin));
  const queuedAllocations = await transaction.allocation.findMany({
    where: { ccmId, creId: null, status: 'assigned', assignmentNeedsReview: true },
    select: { id: true, vehicleId: true, vehicle: { select: { vin: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const allocation of queuedAllocations) queueVins.add(allocation.vehicle.vin);
  const allocations = queueVins.size
    ? await transaction.allocation.findMany({
      where: {
        ccmId,
        status: 'assigned',
        assignmentNeedsReview: true,
        vehicle: { is: { vin: { in: [...queueVins] } } },
      },
      select: { id: true, vehicleId: true, creId: true, assignmentNeedsReview: true, vehicle: { select: { vin: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    : [];
  const workloads = await loadWorkloads(transaction, ccmId, activeCreIds);
  const assignmentByVin = new Map();
  const changes = [];
  for (const entry of queuedEntries) {
    if (assignmentByVin.has(entry.vin)) {
      const ownerUserId = assignmentByVin.get(entry.vin);
      await transaction.masterCallList.update({
        where: { id: entry.id },
        data: { ownerUserId, assignmentNeedsReview: false },
      });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: entry.vehicle.id,
        masterCallListId: entry.id,
        ccmId,
        newCreId: ownerUserId,
        actorUserId: actorId,
        eventType: 'MANUAL_REDISTRIBUTION',
      });
      continue;
    }
    const creId = selectLeastLoadedCre(activeCreIds, workloads);
    assignmentByVin.set(entry.vin, creId);
    await transaction.masterCallList.update({
      where: { id: entry.id },
      data: { ownerUserId: creId, assignmentNeedsReview: false },
    });
    await recordCreAssignmentEvent(transaction, {
      vehicleId: entry.vehicle.id,
      masterCallListId: entry.id,
      ccmId,
      newCreId: creId,
      actorUserId: actorId,
      eventType: 'MANUAL_REDISTRIBUTION',
    });
    changes.push({ vin: entry.vin, creId });
    workloads.set(creId, (workloads.get(creId) || 0) + 1);
  }
  for (const vin of queueVins) {
    if (assignmentByVin.has(vin)) continue;
    const creId = selectLeastLoadedCre(activeCreIds, workloads);
    assignmentByVin.set(vin, creId);
    workloads.set(creId, (workloads.get(creId) || 0) + 1);
    changes.push({ vin, creId });
  }
  for (const allocation of allocations) {
    if (!allocation.assignmentNeedsReview) continue;
    const vin = allocation.vehicle.vin;
    const creId = assignmentByVin.get(vin);
    if (allocation.creId !== creId) {
      await transaction.allocation.update({
        where: { id: allocation.id },
        data: { creId, assignmentNeedsReview: false },
      });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: allocation.vehicleId,
        allocationId: allocation.id,
        ccmId,
        previousCreId: allocation.creId,
        newCreId: creId,
        actorUserId: actorId,
        eventType: 'MANUAL_REDISTRIBUTION',
      });
    }
  }
  await transaction.auditLog.create({
    data: {
      userId: actorId,
      entityType: 'Allocation',
      entityId: ccmId,
      action: 'CRE_PENDING_ASSIGNMENTS_ALLOCATED',
      details: JSON.stringify({ ccmId, assignedCustomers: assignmentByVin.size, changes }),
    },
  });
  return {
    assignedCustomers: assignmentByVin.size,
    pendingCustomers: 0,
    pendingMasterCallListEntries: 0,
    pendingAllocationRecords: 0,
    activeCreCount: activeCreIds.length,
  };
}

export async function unassignCreAssignments(transaction, {
  ccmId,
  departingCreId,
  actorId = null,
  reason = null,
  eventType = 'DEACTIVATED',
}) {
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
        eventType,
      });
    }
    return unassignedCount;
  }

  await lockCcmAllocationTeam(transaction, ccmId);
  const [entries, allocations] = await Promise.all([
    transaction.masterCallList.findMany({
      where: { ccmId, ownerUserId: departingCreId },
      select: { id: true, vin: true, vehicle: { select: { id: true } } },
    }),
    transaction.allocation.findMany({
      where: { ccmId, creId: departingCreId, status: 'assigned' },
      select: { id: true, vehicleId: true, vehicle: { select: { vin: true } } },
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
      eventType,
    });
  }
  for (const allocation of allocations) {
    await transaction.allocation.update({
      where: { id: allocation.id },
      data: { creId: null, assignmentNeedsReview: true },
    });
    await recordCreAssignmentEvent(transaction, {
      vehicleId: allocation.vehicleId,
      allocationId: allocation.id,
      ccmId,
      previousCreId: departingCreId,
      actorUserId: actorId,
      reason,
      eventType,
    });
  }
  await transaction.auditLog.create({
    data: {
      userId: actorId,
      entityType: 'User',
      entityId: departingCreId,
      action: 'CRE_ASSIGNMENTS_PENDING_REDISTRIBUTION',
      details: JSON.stringify({
        ccmId,
        masterCallListEntries: entries.length,
        allocations: allocations.length,
        eventType,
        reason,
      }),
    },
  });
  return new Set([
    ...entries.map(({ vin }) => vin),
    ...allocations.map(({ vehicle }) => vehicle.vin),
  ]).size;
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
      repaired += await unassignCreAssignments(transaction, {
        ccmId,
        departingCreId: user.id,
        actorId,
        reason: 'CRE assignment moved to CCM pending redistribution pool',
        eventType: 'PENDING_REDISTRIBUTION',
      });
    }
  }
  return repaired;
}
