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
    vehicles: {
      some: {
        ccmId: user?.ccmId || 'no-access',
        ...creVehicleWhere(user),
      },
    },
  };
}

export function workshopVisitVisibilityWhere(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'GM') return {};
  const ccmId = user?.ccmId || 'no-access';
  const linkedVehicleScope = {
    physicalVehicle: {
      is: {
        vehicles: { some: { ccmId } },
      },
    },
  };
  if (role === 'CCM') return linkedVehicleScope;
  if (role === 'CRE') {
    return {
      physicalVehicle: {
        is: {
          vehicles: { some: { ccmId, ...creVehicleWhere(user) } },
        },
      },
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
