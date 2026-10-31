import { lockCcmAllocationTeam } from './customerAllocation.js';

export async function findCanonicalMasterCallListEntry(transaction, vin, ccmId) {
  await lockCcmAllocationTeam(transaction, ccmId);
  const entries = await transaction.masterCallList.findMany({
    where: { vin, ccmId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return entries.sort((left, right) => compareCanonicalEntries(left, right, 'ownerUserId'))[0] || null;
}

export function consolidateMasterCallListEntries(entries) {
  const canonicalByScopeAndVin = new Map();
  for (const entry of entries) {
    const key = `${entry.ccmId}\u0000${entry.vin}`;
    const canonical = canonicalByScopeAndVin.get(key);
    if (!canonical || compareCanonicalEntries(entry, canonical) < 0) canonicalByScopeAndVin.set(key, entry);
  }
  return entries.filter((entry) => (
    canonicalByScopeAndVin.get(`${entry.ccmId}\u0000${entry.vin}`) === entry
  ));
}

function compareCanonicalEntries(left, right, ownerField = 'assigneeId') {
  const leftOwner = left[ownerField];
  const rightOwner = right[ownerField];
  if (Boolean(leftOwner) !== Boolean(rightOwner)) return leftOwner ? -1 : 1;
  const leftCreatedAt = new Date(left.createdAt || 0).getTime();
  const rightCreatedAt = new Date(right.createdAt || 0).getTime();
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
  return String(left.id).localeCompare(String(right.id));
}

export function buildAllocationQueueRecords(masterRecords, allocations, ccmId = null) {
  const masterVins = new Set(masterRecords.map(({ vin, ccmId }) => `${ccmId}\u0000${vin}`));
  const grouped = new Map();
  for (const allocation of allocations) {
    if (ccmId && allocation.ccmId !== ccmId) continue;
    const vehicle = allocation.vehicle;
    if (!vehicle?.vin) continue;
    const key = `${allocation.ccmId}\u0000${vehicle.vin}`;
    const group = grouped.get(key) || [];
    group.push(allocation);
    grouped.set(key, group);
  }

  const queueRecords = [];
  for (const [key, group] of grouped) {
    if (masterVins.has(key)) continue;
    const allocation = [...group].sort((left, right) => String(left.id).localeCompare(String(right.id)))[0];
    const vehicle = allocation.vehicle;
    queueRecords.push({
      id: `allocation:${allocation.id}`,
      allocationId: allocation.id,
      allocationQueue: true,
      allocationOnly: true,
      customerId: vehicle.customer?.id || null,
      vehicleId: vehicle.id,
      name: null,
      customerName: null,
      vin: vehicle.vin,
      mobile: null,
      model: vehicle.model || null,
      registrationNumber: vehicle.registrationNumber || null,
      type: allocation.serviceType || null,
      dueCategory: null,
      dueDate: null,
      scheduledAppointment: null,
      ccm: allocation.ccmId,
      ccmId: allocation.ccmId,
      status: 'pending',
      assigneeId: null,
      assigneeName: null,
      importedDetails: null,
      workshopVisits: [],
    });
  }
  return queueRecords;
}

export function includeUnassignedAllocationQueue(masterRecords, allocations, ccmId) {
  const teamAllocations = allocations.filter((allocation) => allocation.ccmId === ccmId);
  const unassignedVinKeys = new Set(
    teamAllocations.map(({ ccmId: allocationCcmId, vehicle }) => `${allocationCcmId}\u0000${vehicle?.vin}`),
  );
  const records = masterRecords.map((record) => ({
    ...record,
    allocationQueue: !record.assigneeId && unassignedVinKeys.has(`${record.ccmId}\u0000${record.vin}`),
  }));
  return records.concat(buildAllocationQueueRecords(records, teamAllocations, ccmId));
}
