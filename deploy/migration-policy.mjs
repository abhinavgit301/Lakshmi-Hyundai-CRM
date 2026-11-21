const approvedNewMigrations = new Set([
  '20261121000000_nullable_unlinked_assignment_history',
]);

export function assertApprovedPendingMigrations(pendingMigrations, newlyCommittedMigrations) {
  const unexpectedNew = [...newlyCommittedMigrations]
    .filter((name) => !approvedNewMigrations.has(name));
  if (unexpectedNew.length) {
    throw new Error(`Refusing migrations: unexpected new migrations in this release: ${unexpectedNew.join(', ')}.`);
  }

  const unexpectedPending = pendingMigrations
    .filter((name) => !approvedNewMigrations.has(name));
  if (unexpectedPending.length) {
    throw new Error(`Refusing migrations: only the nullable assignment-history migration may be pending: ${unexpectedPending.join(', ')}.`);
  }

  const notNew = pendingMigrations.filter((name) => !newlyCommittedMigrations.has(name));
  if (notNew.length) {
    throw new Error(`Refusing migrations: pending migrations are not new in this release: ${notNew.join(', ')}.`);
  }
}
