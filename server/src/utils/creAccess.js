// A CRE works the customers whose vehicles were assigned to them, either
// through the master call list or through a vehicle allocation.
export function creVehicleWhere(user) {
  return {
    OR: [
      { allocations: { some: { creId: user?.id || 'no-access' } } },
      { masterCallListEntries: { some: { ownerUserId: user?.id || 'no-access', ccmId: user?.ccmId || 'no-access' } } },
    ],
  };
}

export function creCustomerWhere(user) {
  return {
    ccmId: user?.ccmId || 'no-access',
    vehicles: { some: creVehicleWhere(user) },
  };
}

export function isVehicleAssignedToCre(vehicle, user) {
  return Boolean(
    vehicle?.allocations?.some((allocation) => allocation.creId === user?.id)
    || vehicle?.masterCallListEntries?.some((entry) => entry.ownerUserId === user?.id && entry.ccmId === user?.ccmId),
  );
}
