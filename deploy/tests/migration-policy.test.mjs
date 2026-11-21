import assert from 'node:assert/strict';
import test from 'node:test';
import { assertApprovedPendingMigrations } from '../migration-policy.mjs';

const nullableHistoryMigration = '20261121000000_nullable_unlinked_assignment_history';

test('allows only the nullable-history migration as a newly pending migration', () => {
  assert.doesNotThrow(() => assertApprovedPendingMigrations(
    [nullableHistoryMigration],
    new Set([nullableHistoryMigration]),
  ));
});

test('allows releases with no pending migration', () => {
  assert.doesNotThrow(() => assertApprovedPendingMigrations([], new Set()));
});

test('rejects any other pending migration even when it is absent from the active release', () => {
  assert.throws(
    () => assertApprovedPendingMigrations(['20261120000001_allocation_vehicle_ccm_fk'], new Set()),
    /only the nullable assignment-history migration may be pending/,
  );
});

test('rejects candidate migrations outside the approved release even when none are pending', () => {
  assert.throws(
    () => assertApprovedPendingMigrations([], new Set([
      '20261119000000_cre_vehicle_assignment_projection',
    ])),
    /unexpected new migrations in this release/,
  );
});

test('rejects the nullable-history migration unless it is new relative to the active release', () => {
  assert.throws(
    () => assertApprovedPendingMigrations([nullableHistoryMigration], new Set()),
    /pending migrations are not new in this release/,
  );
});
