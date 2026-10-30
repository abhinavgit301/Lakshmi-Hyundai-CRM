// A CRE works the customers whose vehicles were assigned to them, either
// through the master call list or through a vehicle allocation.
export function creVehicleWhere(user) {
  const ccmId = user?.ccmId || 'no-access';
  const creId = user?.id || 'no-access';
  return {
    OR: [
      { allocations: { some: { creId, ccmId, status: 'assigned' } } },
      { masterCallListEntries: { some: { ownerUserId: creId, ccmId } } },
    ],
  };
}

export function creCustomerWhere(user) {
  return {
    ccmId: user?.ccmId || 'no-access',
    vehicles: { some: creVehicleWhere(user) },
  };
}

export function workshopVisitVisibilityWhere(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'GM') return {};
  const ccmId = user?.ccmId || 'no-access';
  if (role === 'CCM') return { ccmId };
  if (role === 'CRE') {
    return {
      ccmId,
      vehicle: { is: creVehicleWhere(user) },
    };
  }
  return { id: 'no-access' };
}

export function isVehicleAssignedToCre(vehicle, user) {
  return Boolean(
    vehicle?.allocations?.some((allocation) => allocation.creId === user?.id
      && allocation.ccmId === user?.ccmId
      && allocation.status === 'assigned')
    || vehicle?.masterCallListEntries?.some((entry) => entry.ownerUserId === user?.id && entry.ccmId === user?.ccmId),
  );
}
