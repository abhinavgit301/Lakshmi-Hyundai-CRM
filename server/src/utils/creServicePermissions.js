export function canAccessServiceSource(user, source) {
  const role = String(user?.role || '').toUpperCase();
  const normalizedSource = String(source || '').toUpperCase();

  if (role === 'FREE_SERVICE_CRE') return false;
  if (role !== 'CRE' || normalizedSource === 'SERVICE') return true;
  if (normalizedSource === 'FREE_SERVICE') return user?.freeServiceEnabled === true;
  if (normalizedSource === 'WARRANTY') return user?.warrantyEnabled === true;
  return false;
}

export function allowedServiceSources(user) {
  return ['SERVICE', 'FREE_SERVICE', 'WARRANTY'].filter((source) => canAccessServiceSource(user, source));
}

export function resolveCreServicePermissions({
  existingRole,
  nextRole,
  existingFreeServiceEnabled,
  existingWarrantyEnabled,
  freeServiceEnabled,
  warrantyEnabled,
}) {
  if (String(nextRole || '').toUpperCase() !== 'CRE') {
    return { freeServiceEnabled: false, warrantyEnabled: false };
  }

  const isExistingCre = String(existingRole || '').toUpperCase() === 'CRE';
  return {
    freeServiceEnabled: freeServiceEnabled === undefined
      ? isExistingCre && existingFreeServiceEnabled === true
      : freeServiceEnabled,
    warrantyEnabled: warrantyEnabled === undefined
      ? isExistingCre && existingWarrantyEnabled === true
      : warrantyEnabled,
  };
}
