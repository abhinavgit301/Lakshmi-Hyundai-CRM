import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPrismaSchemaMutationOperation,
  getSchemaMutationError,
} from '../scripts/guard-prisma-schema-mutation.js';

const safeEnvironment = {
  NODE_ENV: 'development',
  ALLOW_LOCAL_PRISMA_SCHEMA_MUTATION: 'true',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/crm_dev?schema=public',
};

const ciEnvironment = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'abhinavgit301/Lakshmi-Hyundai-CRM',
  GITHUB_WORKFLOW: 'CI and controlled production deployment',
  GITHUB_WORKFLOW_REF: 'abhinavgit301/Lakshmi-Hyundai-CRM/.github/workflows/deploy.yml@refs/heads/main',
  NODE_ENV: 'test',
  DATABASE_URL: ['postgresql:', '', 'ci:ci@127.0.0.1:5432/status_test_ci?schema=public'].join('/'),
};

test('allows an explicitly enabled local development schema push', () => {
  assert.equal(getSchemaMutationError('push', safeEnvironment), null);
});

test('allows only the exact disposable GitHub Actions CI database to be pushed', () => {
  assert.equal(getSchemaMutationError('push', ciEnvironment), null);
});

test('refuses CI pushes for production, remote, or unapproved database targets', () => {
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    NODE_ENV: 'production',
  }), /disabled/);
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    DATABASE_URL: ['postgresql:', '', 'ci:ci@db.example.com:5432/status_test_ci?schema=public'].join('/'),
  }), /loopback/);
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    DATABASE_URL: ['postgresql:', '', 'ci:ci@127.0.0.1:5432/production?schema=public'].join('/'),
  }), /approved disposable local database/);
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    DATABASE_URL: ['postgresql:', '', 'ci:ci@127.0.0.1:5433/status_test_ci?schema=public'].join('/'),
  }), /approved disposable local database/);
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    DATABASE_URL: ['postgresql:', '', 'other:ci@127.0.0.1:5432/status_test_ci?schema=public'].join('/'),
  }), /approved disposable local database/);
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    DATABASE_URL: ['postgresql:', '', 'ci:ci@127.0.0.1:5432/status_test_ci?schema=private'].join('/'),
  }), /approved disposable local database/);
  assert.match(getSchemaMutationError('push', {
    ...ciEnvironment,
    GITHUB_WORKFLOW_REF: 'other/repository/.github/workflows/deploy.yml@refs/heads/main',
  }), /approved disposable local database/);
  assert.match(getSchemaMutationError('reset', ciEnvironment), /approved disposable local database/);
});

test('allows reset only for an explicitly enabled local test database', () => {
  assert.equal(getSchemaMutationError('reset', {
    ...safeEnvironment,
    DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/crm_test?schema=public',
  }), null);
});

test('refuses production mutations even when explicitly enabled', () => {
  assert.match(getSchemaMutationError('push', { ...safeEnvironment, NODE_ENV: 'production' }), /disabled/);
  assert.match(getSchemaMutationError('reset', { ...safeEnvironment, NODE_ENV: 'production' }), /disabled/);
});

test('refuses missing opt-in, remote hosts, and unsafe database names', () => {
  assert.match(getSchemaMutationError('push', {
    ...safeEnvironment,
    ALLOW_LOCAL_PRISMA_SCHEMA_MUTATION: undefined,
  }), /Set ALLOW_LOCAL/);
  assert.match(getSchemaMutationError('push', {
    ...safeEnvironment,
    DATABASE_URL: 'postgresql://user:password@db.example.com:5432/crm_dev',
  }), /loopback/);
  assert.match(getSchemaMutationError('reset', safeEnvironment), /ends in _test/);
  assert.match(getSchemaMutationError('push', {
    ...safeEnvironment,
    DATABASE_URL: 'postgresql://user:password@localhost:5432/crm',
  }), /ends in _dev or _test/);
});

test('refuses unsupported operations and invalid URLs', () => {
  assert.match(getSchemaMutationError('migrate', safeEnvironment), /Unsupported/);
  assert.match(getSchemaMutationError('reset', { ...safeEnvironment, DATABASE_URL: 'not-a-url' }), /valid PostgreSQL URL/);
  assert.match(getSchemaMutationError('reset', {
    ...safeEnvironment,
    DATABASE_URL: 'postgresql://user:password@localhost:5432/crm_%ZZ_test',
  }), /valid database name/);
});

test('detects direct Prisma schema push and reset commands for config-level guarding', () => {
  assert.equal(getPrismaSchemaMutationOperation(['node', 'prisma', 'db', 'push']), 'push');
  assert.equal(getPrismaSchemaMutationOperation(['node', 'prisma', 'db', 'push', '--force-reset']), 'reset');
  assert.equal(getPrismaSchemaMutationOperation(['node', 'prisma', '--config', 'prisma.config.ts', 'db', 'push']), 'push');
  assert.equal(getPrismaSchemaMutationOperation(['node', 'prisma', 'generate']), null);
});
