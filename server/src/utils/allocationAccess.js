export async function clearStaleMasterCallListOwner(transaction, { allocation, update, ccmId }) {
  if (update.creId || !update.status || allocation.status !== 'assigned' || update.status === 'assigned') return;

  const [activeAllocations, entry] = await Promise.all([
    transaction.allocation.findMany({
      where: { vehicleId: allocation.vehicleId, ccmId, status: 'assigned' },
      select: { creId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    transaction.masterCallList.findFirst({
      where: { vin: allocation.vehicle.vin, ccmId, ownerUserId: allocation.creId },
      select: { id: true, ownerUserId: true },
    }),
  ]);
  if (!entry || entry.ownerUserId !== allocation.creId) return;

  const nextOwnerId = activeAllocations.find(({ creId }) => creId)?.creId || null;
  if (nextOwnerId === allocation.creId) return;

  await transaction.masterCallList.updateMany({
    where: { vin: allocation.vehicle.vin, ccmId, ownerUserId: allocation.creId },
    data: { ownerUserId: nextOwnerId },
  });
}
