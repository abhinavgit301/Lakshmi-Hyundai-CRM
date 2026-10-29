export const APPROVED_TEST_DATABASE = 'lh_import_rollback_test';

export function validateTestDatabaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Set TEST_DATABASE_URL to the dedicated local import integration-test database.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL is invalid.');
  }

  const allowedProtocols = new Set(['postgres:', 'postgresql:']);
  const allowedHosts = new Set(['127.0.0.1', 'localhost']);
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL is invalid.');
  }

  if (!allowedProtocols.has(url.protocol)
    || !allowedHosts.has(url.hostname.toLowerCase())
    || databaseName !== APPROVED_TEST_DATABASE
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('TEST_DATABASE_URL must target the approved database on 127.0.0.1 or localhost.');
  }

  return value;
}

export function configureTestDatabaseUrl(value) {
  const databaseUrl = validateTestDatabaseUrl(value);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PG')) delete process.env[name];
  }
  process.env.DATABASE_URL = databaseUrl;
  return databaseUrl;
}
