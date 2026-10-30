# Repair-order import recovery and rollback

## Processing and recovery

Each import holds a transaction-scoped PostgreSQL advisory lock for its batch on a dedicated connection; the open transaction keeps the connection pinned if the database URL uses a transaction pooler. Each row mutation also locks and checks the batch row inside its own transaction before writing. Row-scoped change logs point to their durable input-row progress record. Completing a row writes its outcome, mutation state, and exact linked-log count in the same transaction as the business mutation and change logs. Known skipped/rejected rows explicitly record no mutations; successful repair-order rows must have a repair-order CREATE log, and flagged rows must have a conflict-review CREATE log.

The final allocation pass is batch-scoped because its assignment decisions can affect older call-list entries and cannot be attributed to one source row. Its call-list owner and allocation CRE updates, change logs, `allocationEvidenceState`, and `allocationChangeCount` commit in the same transaction. Recovery and rollback validate the batch-level evidence independently from row evidence. Update snapshots include both the prior and resulting `updatedAt`; rollback verifies the expected post-update fields and restores the exact prior values so earlier CREATE snapshots can still be checked in reverse order.

Repair-order duplicate behavior remains unchanged: an already-existing VIN/repair-order pair is skipped, while a new repair order for an existing VIN creates another repair-history entry.

An Admin can request recovery for a `processing` batch (or a failed batch that is not yet rollback-supported) from Import History. Recovery only proceeds when the processing advisory lock is free and the durable row outcomes, mutation states, linked-log counts, required mutation types, and snapshots all agree. CREATE snapshots must contain every scalar field for their entity and rollback compares the complete current record, including nullable values and timestamps. Missing, truncated, orphaned, or contradictory evidence blocks recovery and rollback. Historical imports without row-linked evidence remain non-reversible; recovery never fills in missing evidence or marks a batch completed. Incomplete batches move to `recovery_blocked`; their business data is left untouched and rollback remains disabled.

The lock is released automatically when the worker process or database transaction terminates. Recovery does not use batch age as evidence that a worker is abandoned.

## Counts and retained records

Row outcomes and processed-row totals come from transactional `import_row_progress` records. A successful import's affected-record totals are distinct entity counts derived from `import_change_logs`. Legacy failed batches without durable row progress display progress and outcomes as unknown; legacy completed batches may show their stored row totals with an explicit unverified-history label. The UI hides row outcome totals while newer row processing is incomplete and does not present affected-entity totals as complete unless change-log completeness was verified.

Rollback reverses business-data entries recorded in the change log. Import batches, row-progress records, row-error details, import change-log records, and audit-log entries are intentionally retained. They provide the import result and rollback/recovery audit trail; rollback does not erase the import history.

## Permanent import deletion

Permanent deletion is a separate Admin-only operation; `DELETE /imports/:id` remains the safe rollback endpoint. Admins can request `GET /imports/:id/permanent-deletion/preview` to review the import filename and timestamp, direct and dependent record counts, later import batches and rows affected, records to restore, and a confirmation token bound to the reviewed scope. Confirmation uses `DELETE /imports/:id/permanent-deletion` with that token. The server rebuilds the plan inside a serializable transaction, locks the target and affected import batches and CCM allocation teams, and aborts if the scope has changed.

The deletion plan starts with verified CREATE change logs for the selected import. It includes repair orders and vehicles subsequently created for an imported customer, plus related master-call-list entries, allocations, calls, follow-ups, appointments and appointment events, ownership history, free-service milestones, and VIN conflict reviews. Monthly customer-data rows are retained and detached from deleted customers/vehicles. Customer, vehicle, and other tracked records that the selected import only updated are restored from their recorded before-state, while preserving verified later tracked field updates. If ownership or update state cannot be verified, deletion is blocked rather than guessing.

The target import batch and its row/change logs are retained and marked permanently deleted. Change logs for records removed through the cascade are marked `permanently_deleted` with the causing Import ID. Later batches and their row evidence remain available; their histories report invalidated rows and causing Import IDs. Safe rollback skips those invalidated changes, so neither rollback nor recovery can recreate permanently deleted records. An audit entry records the Admin, timestamp, source file, per-entity deletion counts, affected later batches, and restored records. No schema change is required.

The permanent-deletion integration scenario must be run only through the guarded `npm run test:integration` runner against the dedicated local `lh_import_rollback_test` database. `TEST_DATABASE_URL` was not configured for the current implementation session, so no database-backed permanent deletion or import integration test was run.

## Database deployment

The server package currently documents `npm run prisma:push` (`prisma db push`) as its schema workflow. The SQL files under `prisma/migrations` are not run by that package script and do not establish a complete Prisma Migrate baseline. Do not mix `prisma migrate deploy` into the current deployment process without first baselining and verifying the production migration history. Review schema changes and test the existing push workflow against an isolated, production-like database before applying it to any hosted database.

The `MasterCallList.vehicle` relation keeps its VIN required and now uses `Restrict`: call-list records retain the VIN and cannot be detached by deleting their referenced vehicle. Rollback explicitly detects those references and blocks vehicle deletion. This preserves the call-list entry rather than setting a required VIN to null.

## PostgreSQL integration tests

`npm run test:integration` runs the real PostgreSQL recovery and rollback suite. It requires an explicitly supplied `TEST_DATABASE_URL`, accepts only `localhost` or `127.0.0.1`, and requires the database name `lh_import_rollback_test`. It rejects missing URLs, other hosts or database names, and URL query/fragment overrides before starting the test process. The runner uses that validated URL as `DATABASE_URL`, removes inherited `PG*` connection overrides, and does not fall back to `.env` or the application's configured database. Test fixtures use unique IDs and clean up only those IDs.

The test database and role must be provisioned separately. After the dedicated local database has been reviewed and provisioned, set `TEST_DATABASE_URL` in the current PowerShell process and use `npm run prisma:push:integration` to apply the Prisma schema. This wrapper validates the explicit URL before Prisma starts, accepts only the approved loopback host and database name, and assigns the validated URL to `DATABASE_URL` for Prisma. It never prints the connection string.

Do not use the general-purpose `npm run prisma:push` or destructive `npm run prisma:reset` scripts for test provisioning unless the target has been independently verified; those commands do not enforce the integration database guard and may use `.env` or inherited application settings. The integration suite was not run as part of this code change because the database must not be accessed before review.
