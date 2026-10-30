import { creCustomerWhere, creVehicleWhere } from './creAccess.js';

function normalizeRole(role) {
  const value = String(role || '').toUpperCase();
  if (value === 'ADMIN') return 'Admin';
  if (value === 'GM') return 'GM';
  if (value === 'CCM') return 'CCM';
  if (value === 'CRE') return 'CRE';
  if (value === 'FREE_SERVICE_CRE' || value === 'FREE-SERVICE CRE') return 'FREE_SERVICE_CRE';
  return value;
}

export function appointmentVisibilityWhere(user) {
  const role = normalizeRole(user?.role);
  if (role === 'Admin' || role === 'GM') return {};
  if (role === 'CCM') {
    const ccmId = user.ccmId || 'no-access';
    return {
      ccmId,
      AND: [
        { OR: [{ customerId: null }, { customer: { is: { ccmId } } }] },
        { OR: [{ vehicleId: null }, { vehicle: { is: { ccmId } } }] },
      ],
    };
  }
  if (role === 'FREE_SERVICE_CRE') {
    const ccmId = user?.ccmId || 'no-access';
    return {
      ccmId,
      createdById: user?.id || 'no-access',
      customerId: null,
      OR: [{ vehicleId: null }, { vehicle: { is: { ccmId } } }],
    };
  }
  if (role !== 'CRE') return { id: 'no-access' };
  return {
    ccmId: user?.ccmId || 'no-access',
    OR: [
      { assigneeId: user?.id || 'no-access' },
      { createdById: user?.id || 'no-access' },
    ],
    AND: [
      { customer: { is: creCustomerWhere(user) } },
      {
        OR: [
          { vehicleId: null },
          { vehicle: { is: { ccmId: user?.ccmId || 'no-access', ...creVehicleWhere(user) } } },
        ],
      },
    ],
  };
}

export { normalizeRole as normalizeAppointmentRole };