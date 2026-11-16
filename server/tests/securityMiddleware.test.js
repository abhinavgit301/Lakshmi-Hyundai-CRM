import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSecurityConfiguration,
  createSecurityMiddleware,
  getAllowedOrigins,
  getJwtSecret,
} from '../src/middleware/securityMiddleware.js';

function invoke(req, origins) {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    header(name, value) { headers[name] = value; return this; },
    vary(value) { headers.Vary = value; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let continued = false;
  createSecurityMiddleware(origins)(req, res, () => { continued = true; });
  return { headers, res, continued };
}

test('JWT secrets must be explicitly configured with at least 32 characters', () => {
  assert.throws(() => getJwtSecret({}), /at least 32 characters/);
  assert.throws(() => getJwtSecret({ JWT_SECRET: 'short' }), /at least 32 characters/);
  assert.equal(getJwtSecret({ JWT_SECRET: 'test-secret-with-more-than-32-characters' }), 'test-secret-with-more-than-32-characters');
});

test('production requires HTTPS CORS origins and a configured JWT secret', () => {
  assert.throws(() => assertSecurityConfiguration({ NODE_ENV: 'production' }), /JWT_SECRET/);
  assert.throws(() => assertSecurityConfiguration({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-secret-with-more-than-32-characters',
  }), /CORS_ALLOWED_ORIGINS/);
  assert.throws(() => assertSecurityConfiguration({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-secret-with-more-than-32-characters',
    CORS_ALLOWED_ORIGINS: 'http://crm.example.com',
  }), /HTTPS origin/);
  assert.doesNotThrow(() => assertSecurityConfiguration({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-secret-with-more-than-32-characters',
    CORS_ALLOWED_ORIGINS: 'https://crm.example.com',
  }));
});

test('CORS origin configuration rejects paths and wildcard origins', () => {
  assert.throws(() => getAllowedOrigins({ CORS_ALLOWED_ORIGINS: 'https://crm.example.com/path' }), /exact HTTP\(S\) origins/);
  assert.throws(() => getAllowedOrigins({ CORS_ALLOWED_ORIGINS: '*' }), /valid origins/);
});

test('allowed origins receive credentialed CORS headers', () => {
  const { headers, continued } = invoke({
    method: 'GET',
    get: () => 'https://crm.example.com',
    cookies: {},
  }, ['https://crm.example.com']);
  assert.equal(continued, true);
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://crm.example.com');
  assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
  assert.equal(headers.Vary, 'Origin');
});

test('allowed origins can make cookie-authenticated writes', () => {
  const { continued, headers } = invoke({
    method: 'POST',
    get: () => 'https://crm.example.com',
    cookies: { token: 'cookie-token' },
  }, ['https://crm.example.com']);
  assert.equal(continued, true);
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://crm.example.com');
});

test('untrusted origins cannot preflight or send cookie-authenticated writes', () => {
  const preflight = invoke({
    method: 'OPTIONS',
    get: () => 'https://untrusted.example',
    cookies: {},
  }, ['https://crm.example.com']);
  assert.equal(preflight.res.statusCode, 403);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], undefined);

  const write = invoke({
    method: 'POST',
    get: () => 'https://untrusted.example',
    cookies: { token: 'cookie-token' },
  }, ['https://crm.example.com']);
  assert.equal(write.res.statusCode, 403);
  assert.equal(write.continued, false);
});

test('cookie-authenticated writes require an allowed origin; bearer writes remain supported', () => {
  const missingOrigin = invoke({
    method: 'PATCH',
    get: () => undefined,
    cookies: { token: 'cookie-token' },
  }, ['https://crm.example.com']);
  assert.equal(missingOrigin.res.statusCode, 403);

  const bearer = invoke({
    method: 'PATCH',
    get: () => undefined,
    headers: { authorization: 'Bearer token' },
    cookies: {},
  }, ['https://crm.example.com']);
  assert.equal(bearer.continued, true);
});
