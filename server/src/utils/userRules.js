export function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidUsername(value) {
  return /^[a-z0-9][a-z0-9._-]{2,39}$/.test(String(value || ''));
}

export function validateOptionalPhone(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  const phone = String(value).trim();
  const digits = phone.replace(/\D/g, '');
  if (phone.length > 30 || digits.length < 7 || digits.length > 15) {
    return { error: 'Phone number must contain 7 to 15 digits.' };
  }
  return { value: phone };
}