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
  if (role === 'CCM') return { ccmId: user.ccmId || 'no-access' };
  if (role === 'FREE_SERVICE_CRE') {
    return {
      ccmId: user?.ccmId || 'no-access',
      createdById: user?.id || 'no-access',
      customerId: null,
    };
  }
  return {
    ccmId: user?.ccmId || 'no-access',
    OR: [
      { assigneeId: user?.id || 'no-access' },
      { createdById: user?.id || 'no-access' },
    ],
  };
}

export { normalizeRole as normalizeAppointmentRole };