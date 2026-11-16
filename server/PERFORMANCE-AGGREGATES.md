# Performance aggregation: operations and benchmark guide

This document describes the derived-data rollout. It does not authorize or perform a production rollout.
Production use still requires explicit approval, a verified backup, a verified target identity, and a reviewed deployment window.

## What is stored

`cre_call_daily` is the immediate tier. CallLog writes update it in the same transaction, for `OWNED` and `TEAM` scopes and the workshop date. The daily Calls Made and Calls Picked Up fields read these transactional counters; they do not depend on snapshot refresh.

`cre_performance_snapshots` is the snapshot tier. It stores the other metrics exposed by the ordinary CRE performance summary and the month call total for the separate `/performance/free-service` endpoint. A snapshot key is the full tuple `(creId, ccmId, year, month, viewer)`. Viewer values are `CRE`, `CCM`, and `FREE_SERVICE_CRE`; these rows are distinct and must not be merged.

The Free-Service endpoint has no workload, due-service, follow-up, or warranty fields to snapshot. Its existing `dailyPerformance` and `recentCalls` remain live response fields. Its month call total is persisted. CCM requests are constrained to the target Free-Service CRE's current CCM.

The response's additive `snapshot` object reports `status`, `isStale`, `computedAt`, `asOf`, and `lastError` while the read feature flag is on. A missing snapshot returns a null month total and `pending`; last-good values may remain visible with a non-`ok` freshness status. With the read flag off, the existing live response remains in use.

## Environment and target safeguards

Never use `server/.env` with the aggregate scripts. They read `server/.env.bench` by default, enforce the exact local bench database, and make read-only sessions for reconciliation and benchmark commands. The explicitly approved local bench write path accepts `BENCH_SEED_DATABASE_URL` only from `server/.env.bench.seed`; it still verifies localhost and the exact `lakshmi_hyundai_crm_bench` database before connecting. For any explicitly approved non-bench operation, use a separate restricted env file and satisfy every `perf-db.mjs` target check; never place credentials in shell history or reports.

Before any database operation, verify and retain the output showing database name, host, user, server version, timezone, and read-only/write mode. Stop if the target is unexpected. Never select a production URL for a benchmark, test, or dry run.

## Snapshot call-list optimization

`PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED` defaults to `false`. When explicitly set to `true` or `1`, ordinary CRE and CCM-viewed snapshot calculations use a snapshot-specific loader; the Master Call List and live performance summary keep their existing loader. Free-Service CRE snapshots do not use this call-list calculation. This flag does not enable snapshots or maintenance.

On-demand requests insert missing snapshot rows and wake the scheduler rather than starting independent calculations. The scheduler calls `refreshSnapshot`, which claims the snapshot, looks up the user, computes metrics, and persists the result. Existing rows are not reset, so retry backoff and last-good values are retained. The database is the work queue; requests arriving during a running batch remain eligible for a later tick. For ordinary CRE snapshots, `computeCrePerformanceMetrics` starts the call-list load alongside the other metric queries, then classifies the records and persists the computed snapshot through the existing refresh flow. Failed refreshes keep the last good values and use the existing retry/backoff behavior.

The legacy call-list loader retrieves assigned or allocated records in 100-row pages. It loads shared physical-vehicle workshop history and enriches every input row with list-oriented data including appointments, allocations, monthly entries and dealer information, before selecting one canonical record per CCM and VIN. The snapshot metrics use customer identity, sale date, visible workshop history, lifecycle and due date, but not that presentation enrichment. The optimized loader selects canonical records first, loads only the required fields and visible physical-vehicle histories in batches, and reuses a lifecycle result within that calculation only for the same record and evaluation time. It preserves the existing history visibility, ordering, canonical selection, date handling and classification functions; it does not cache between snapshots or change scheduling.

The approximately 10,743 rows observed in production are inputs to the existing CRE-scoped workload calculation, not evidence that users opened the Master Call List. The canonical records and their histories remain necessary for existing due and free-service rules. The production samples did not establish the exact cause of the eleven-minute phases, the individual SQL statements responsible, or how much time was attributable to application processing versus database and host contention.

Before any approved rollout, compare both paths on representative, isolated production-like data with realistic concurrent updates and history sizes. Verify exact metrics for both viewers, role restrictions, CCM isolation, free/paid/unknown histories, month and timezone boundaries, refresh failures and retries, and Master Call List behavior. Measure query plans, database load, worker memory and snapshot durations under realistic contention. The isolated CI parity test is useful but does not certify production equivalence or performance.

By default both loaders use multiple database queries without a consistent transaction snapshot. Their query timing differs, so concurrent changes can produce different observations even though stable-data results match. An experimental consistent-read mode is described below; it is off by default. Existing invalidation does not yet have verified coverage of every metric-affecting write. Keep the slim-loader flag off until complete transactional invalidation and representative concurrency and performance validation are finished and separately approved.

## Experimental consistent snapshot reads

`PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED` defaults to `false` and is independent of the slim-loader flag. When explicitly enabled, the user lookup and all metric input queries for either loader and all snapshot viewers run through one read-only PostgreSQL `REPEATABLE READ` transaction. Publication occurs separately and remains conditional on the claim token, dirty version, and captured source revisions. A missing-user deletion is likewise fenced against intervening invalidations. A write outside the invalidation protocol can still cause an obsolete result to be published; consistent reads alone cannot fix incomplete Phase 2 coverage.

The read transaction waits at most two seconds for a connection and has a 60-second Prisma transaction deadline, plus transaction-local PostgreSQL statement and idle-in-transaction timeouts of 60 seconds. A slow statement is cancelled server-side; this is not a hard 60-second wall-clock guarantee for every combination of application processing and statements. The call-list loader still does record processing inside the transaction, while final cohort classification and metric assembly run after it releases its connection. Timeouts and calculation errors mark the attempt failed and preserve last-good metrics. A read holds one pool connection and a PostgreSQL MVCC snapshot for its duration; concurrent refreshes can increase pool pressure and delay vacuum cleanup. The scheduler permits two concurrent refreshes per process, not per deployment.

Previously observed call-list phases took approximately 11 minutes; this mode can therefore time out rather than refresh successfully on that workload. It is an experimental safety boundary, not a production-ready solution for that dataset. Do not enable either flag in production without completing Phase 2, validating all roles and concurrent application writes, and measuring transaction durations, pool usage, vacuum impact, refresh success and freshness on representative data. If the bound cannot be met, redesign the calculation to capture metric inputs in a short transaction and process them after commit; do not extend the bound blindly. Turning this flag off restores the prior multi-query behavior, not a consistent snapshot guarantee.

Only after those prerequisites, separate review and deployment approval, enable the flag through the normal application configuration and restart process. Monitor snapshot duration, failure and freshness logs, database load and worker memory. The slim loader emits a `call_list_loaded` event with aggregate input-row, canonical-record, physical-vehicle and visit counts, without customer data. To roll back this optimization, set the flag to `false` and use the normal approved restart process; no schema rollback is needed. This change does not authorize or perform a production deployment.

## Snapshot publication fencing (incomplete remediation)

The local fencing change adds claim tokens and per-row dirty versions. An owned worker conditionally publishes its metrics and status in one transaction; a replaced worker cannot publish, fail, or delete its replacement's row. A dirty-version or revision mismatch preserves last-good metrics and releases the claim as dirty. Call, follow-up, and appointment application writes advance the affected CCM revision and dirty all months of that CCM inside their source transaction when maintenance is enabled. Unknown CCM scope falls back to the global revision and all snapshots. The refresh signal follows commit. This serializes writes against publication for the same CCM and can increase refresh work for historical snapshots; its load has not been measured at production scale.

Manual workshop records, processed repair-order import rows, import rollback, permanent deletion, legacy cleanup and free-service milestone synchronization use global transactional invalidation because physical-vehicle histories can cross CCM boundaries. Milestone updates commit in batches of at most 100 vehicles; a later batch failure leaves earlier committed batches invalidated. Monthly customer entries, import rows and import completion, customer creation, and sale-date startup backfill invalidate the affected CCMs in their source transactions. Backfill updates only a still-null date and rolls back that update if invalidation fails. This is conservative: each processed repair-order row updates the global revision and dirties all snapshot rows across every month. Large imports and milestone batches can cause substantial write amplification, lock contention and refresh churn; production-scale measurements and a safe bounded alternative are required before deployment.

CRE assignment events and account changes now advance the affected CCM revisions and dirty all months inside the source transaction, including both CCMs on transfer. Unknown entity scope falls back to global invalidation. Repeated invalidation of the same scope in one transaction is coalesced. The tests include an actual call-list reassignment during a blocked refresh and CRE deactivation. Customer and vehicle changes beyond the already converted paths, other write paths, and multi-process lock ordering still require verification. Existing post-response invalidation must not be treated as an atomic guarantee. The consistent-read mode is off by default. Consequently an `ok` status is not yet a guarantee of a consistent or up-to-date view.

When allocation synchronization changes a call-list row's vehicle link without changing its CRE, it now rebuilds affected call aggregates and globally invalidates snapshots in the same transaction. An unchanged link does not cause this extra invalidation. Monthly customer entries, repair-order imports and manual repair-order entries also rebuild the existing owner's call aggregates when they attach or replace the linked vehicle; import rollback rebuilds them when restoring that link. A PostgreSQL regression verifies both loaders' changed due counts, a blocked refresh retaining last-good values, cross-team invalidation, and aggregate/live-count parity after monthly and manual entries, import and rollback. This coverage does not demonstrate every possible write or production-scale contention.

Legacy monthly datasets can acquire their CCM during a read or a write request, changing which completed import determines the snapshot cycle start. That attachment now advances the CCM revision and dirties snapshots in the same transaction. A PostgreSQL test checks that an invalidation failure rolls the attachment back and that an in-flight refresh cannot publish the old cycle.

The application's interactive transaction wrapper coalesces invalidations until after pending aggregate rebuilds, then advances revisions and marks snapshots dirty before commit. This orders aggregate locks before revision and snapshot locks; failure during invalidation rolls back the source write. Unknown scopes subsume CCM scopes and otherwise CCM revisions are acquired in sorted order. The previously reproduced aggregate-versus-revision lock inversion no longer occurs in the deterministic PostgreSQL test. This does not prove that every possible lock combination or multi-process application path is free of deadlocks; representative contention testing remains required.

The snapshot integration suite also starts independent worker processes to test claim takeover, failure, process termination, a follow-up committed immediately before publication, and retry. A partial repair-order import test exercises a newly created vehicle, a rejected row, transactional invalidation and rollback. These tests run against the disposable CI database and do not establish comprehensive coverage for every application write path or production-scale behavior.

The scheduler applies failed-refresh backoff in the database query before limiting the batch. Eligible rows are ordered by oldest attempt, with never-attempted work first, so repeated failed attempts cannot continually precede older pending or dirty work just because of status ordering. Retries retain their existing exponential delays of one, two, four and eight minutes, capped at fifteen minutes. Unit tests check each boundary; a PostgreSQL test checks pending and dirty work alongside a backlog of 70 failed rows, including after those failures become eligible. This does not guarantee freshness under sustained overload.

The normal backend test runner serializes test files whenever `SNAPSHOT_INTEGRATION_DATABASE_URL` is set. Run `npm run test:snapshot` for the dedicated snapshot integration suite; it requires that URL and always serializes files. Direct Node test commands must also specify `--test-concurrency=1`, because the tests share global revision state in their disposable database. Do not point these tests at production or run separate suites concurrently against the same database.

With snapshot maintenance disabled, Free Service milestone updates run in batches of at most 20 concurrent operations. With maintenance enabled they remain sequential inside each transaction so milestone writes and invalidation commit together. A delayed mock confirms the concurrency bound, not real endpoint performance; measure the endpoint and database load under representative traffic before rollout.

Free Service visits complete the earliest uncompleted milestone that has not expired on the visit date, rather than always consuming the first uncompleted milestone. This intentionally changes historical and current snapshot metrics. The `20261117000000_free_service_expiry_invalidation` migration advances the global revision and dirties all snapshot periods while preserving last-good values and in-flight claims. It follows the fencing and sequence invalidation migrations; stop old workers before applying it, use the approved migration/rollback process, and monitor the resulting refresh backlog. Older code must not publish after this migration. Ongoing service-entry, import, sale-date backfill, list synchronization, rollback, and permanent-deletion paths now reconcile milestone references against the full shared physical-vehicle history while holding the physical-vehicle lock. If the sale date is unavailable during removal, reconciliation can clear only references that resolve exactly or unambiguously to the removed visit; it does not attempt a full rematch.

Existing databases still need a one-time reconciliation. During an approved maintenance window stop all application writers and workers, verify the database target and backup, then run `node scripts/reconcile-free-service-milestones.js --maintenance-window` to preview a full shared-history reconciliation. Resolve all reported vehicle IDs and rerun the preview before applying with `node scripts/reconcile-free-service-milestones.js --apply --maintenance-window`. Both modes take database write locks. The script preserves due dates and visit history and aborts the entire apply if a sale date is missing, ambiguous, invalid or in the future, or a milestone has an unsupported state. Do not treat this implementation or its tests as production readiness: the migration, one-time data reconciliation, deployment sequence, lock/load behavior and rollback plan still require production-specific review and approval.

The legacy import recovery, rollback and permanent-deletion integration fixtures now include physical-vehicle identities and run in a dedicated local test database with maintenance both enabled and disabled; all 19 tests passed locally. A separate two-process test drives real follow-up controller writes and deliberately holds the CCM revision lock before the first transaction flush. PostgreSQL confirms the second transaction waits on that lock; both commits succeed, advance the revision and dirty version, and retain last-good snapshot values. This controlled lock scenario does not establish deadlock freedom for other write combinations or production-scale contention. CI runs both suites with maintenance enabled.

Another two-process test overlaps an actual CRE call with a CCM reassignment. It holds the call transaction after its aggregate update and verifies through PostgreSQL that the assignment's aggregate rebuild waits for that transaction. Both writes commit, the aggregate matches the live scope after reassignment, both invalidations advance the revision, and a blocked snapshot refresh retains its last-good value rather than publishing its obsolete result. The reverse ordering also tests a call committed while reassignment is uncommitted and verifies aggregate parity for both CREs. These are controlled orderings, not every possible application-write combination.

A separate three-process test holds a manual workshop-history write before commit while two CCM refresh workers wait to publish. It verifies pre-commit invisibility, post-commit visibility to both CREs sharing the physical vehicle, global revision advancement and preservation of both workers' last-good values. This is not a representative import load or a production-scale cross-CCM contention test.

The full backend suite now runs in CI with `PERFORMANCE_AGGREGATES_MAINTAIN=true` and both experimental snapshot flags enabled in the test process. Local validation passed 508 tests with 18 skipped in that configuration; with maintenance and both flags off, 507 passed and 19 were skipped. The earlier 31 maintenance-on failures involved incomplete transaction doubles; the repaired fixtures record revision and dirty-mark operations, and a rollback test verifies that an invalidation error aborts the source transaction. The snapshot parity fixture also no longer reads unrelated follow-ups from the database. Separately, the disposable PostgreSQL import suite passed 19 tests with maintenance enabled and disabled, and the snapshot integration suite passed 14. These results do not establish comprehensive write-path coverage or production-scale behavior.

The additive `prisma/migrations/20261115000000_snapshot_publication_fencing/migration.sql` requires the existing aggregate migration first. It adds snapshot columns and a revision table, seeds the global revision, and marks existing clean and in-flight snapshots dirty without deleting their values. New application code requires this schema even with the slim-loader flag off. This migration has not been authorized for production.

For any future approved deployment, quiesce **all** old backend workers and wait for in-flight work to stop before applying the migration or starting new workers. Old workers do not honor claim tokens and can overwrite newer results; mixed-version rolling operation is unsafe. Verify the migration and global revision row before starting new workers. Rollback to old application code also requires stopping all new workers first; old code loses fencing protection, so keep snapshot use and the slim loader disabled until a separately reviewed recovery procedure is complete. Do not remove the added schema without a separately tested database rollback plan.

## Migration and initialization procedure

The migration is plain SQL and is intentionally not run at application startup. The viewer constraint includes `FREE_SERVICE_CRE` so those snapshot rows are valid.

1. Review the migration and rollback SQL. Take and verify a restorable database backup using the organization's established backup procedure.
2. Verify the intended database identity using a read-only connection first. Confirm the database name, server, timezone, and that it is not production unless a separately approved production change is underway.
3. During an approved rollout window, apply `prisma/migrations/20261113000000_performance_aggregates/migration.sql` exactly once with `psql -v ON_ERROR_STOP=1`. Do not use `prisma db push` or a reset command.
4. With all old workers quiesced, apply `prisma/migrations/20261115000000_snapshot_publication_fencing/migration.sql` exactly once if deploying code that includes fencing. Verify both tables and indexes, the snapshot primary key over the five key columns, and the `global` revision row. Verify the viewer check accepts `CRE`, `CCM`, and `FREE_SERVICE_CRE`. The fencing migration requires its own separate approval and does not complete the consistency remediation.
5. Configure `PERFORMANCE_AGGREGATES_MAINTAIN=true` and keep `PERFORMANCE_AGGREGATES_ENABLED=false`. Restart the backend so transactional maintenance and the scheduler start while API reads remain on the live path.
6. Run the backfill dry run and review the target identity and mismatch totals:

   ```powershell
   node scripts/performance/backfill-performance-aggregates.mjs --seed-snapshots
   ```

7. After explicit approval to write to the verified target, apply the backfill. It rebuilds one caller at a time in its own transaction and seeds pending current-month snapshots for ordinary CREs and Free-Service CREs:

   ```powershell
   node scripts/performance/backfill-performance-aggregates.mjs --apply --seed-snapshots
   ```

   Use `--batch-size` only to tune processing cadence and `--user` only for an explicitly scoped run. Do not start a second backfill concurrently.
8. Reconcile read-only and preserve the report:

   ```powershell
   node scripts/performance/reconcile-performance-aggregates.mjs --out performance-aggregate-reconcile.json
   ```

   Reconciliation compares stored counters to source CallLogs and reports snapshot status/orphans. Exit code `0` means no detected counter mismatch or orphan; it does not certify API parity by itself.
9. If reconciliation finds differences, investigate first. The repair script is dry-run by default:

   ```powershell
   node scripts/performance/repair-performance-aggregates.mjs --max-users 200
   ```

   Apply repair only after reviewing the identified users and approving the write:

   ```powershell
   node scripts/performance/repair-performance-aggregates.mjs --apply --max-users 200
   ```

10. Run tests, API parity checks, and endpoint benchmarks against the approved non-production target. Inspect freshness status for both `CRE` and `FREE_SERVICE_CRE` snapshots. Enable `PERFORMANCE_AGGREGATES_ENABLED=true` only after those results are reviewed and separately approved.

For an explicitly approved non-bench target, aggregate scripts additionally require `--env-file <restricted-file> --expect-db <exact-name> --allow-non-bench`, `PERFORMANCE_SCRIPTS_ALLOW_NON_BENCH=yes`, and, for writes, `--confirm <exact-name>@<host>`. The scripts print and verify the live connection identity before data queries.

## Reconciliation and repair semantics

- `reconcile-performance-aggregates.mjs` is strictly read-only; it forces and verifies read-only mode.
- `repair-performance-aggregates.mjs` is read-only unless `--apply` is passed. Apply rewrites only callers whose stored rows differ, one transaction per caller, and marks that caller's current-month snapshots dirty.
- `backfill-performance-aggregates.mjs` is read-only unless `--apply` is passed. Apply re-derives counters and is idempotent.
- None of these scripts applies the migration, starts automatically, or changes feature flags.
- Scheduler refresh runs every minute and targets current snapshots after ten minutes, leaving room under the 15-minute freshness limit. Refresh failures retain last-good metric values and expose failure status; retry uses backoff.
- Refresh diagnostics are JSON log lines with `component: "performance_snapshot"`. Correlate by `attemptId`; `phase_start` without `phase_end` identifies the pending phase. Call-list progress reports aggregate page and row counts at the first page, every ten pages, and the final page. Durations include pool waits and do not by themselves distinguish them from query execution or JavaScript processing. These diagnostics do not cancel stalled work or change refresh behavior.

## Legacy aggregate schema rollback

The following legacy procedure is not a rollback plan for the local fencing changes. Do not remove aggregate tables while fencing-aware code or any worker may use them. A fencing deployment requires a separately tested database rollback plan; prefer disabling snapshot reads and retaining the additive schema. The legacy rollback removes derived aggregate/snapshot tables, not source CRM records.

1. Set `PERFORMANCE_AGGREGATES_ENABLED=false` and `PERFORMANCE_AGGREGATES_MAINTAIN=false`, then restart the backend. Verify logs show the scheduler is not active and the legacy API path is serving requests.
2. Verify the exact database identity again and ensure no application instance still depends on the aggregate tables.
3. Apply `prisma/migrations/20261113000000_performance_aggregates/rollback.sql` with `psql -v ON_ERROR_STOP=1` on the same approved target.
4. Verify both derived tables are absent and legacy CRM endpoints still work.
5. Keep the migration source files for a future controlled re-application. Re-application requires recreating and backfilling the derived tables before enabling reads.

Do not roll back by deleting customer, vehicle, CallLog, import, or ownership data. Do not run `prisma migrate reset`, `prisma db push --force-reset`, or an automatic migration command.

## Phase 5: validation and rollout gate

Phase 5 is not complete and this section is not authorization to deploy. Phase 2 write-path and contention coverage, Phase 3 production-scale consistent-read viability, and the validation below must be completed and reviewed before either snapshot flag is enabled in production. Keep `PERFORMANCE_SNAPSHOT_SLIM_CALL_LIST_ENABLED=false` and `PERFORMANCE_SNAPSHOT_CONSISTENT_READS_ENABLED=false` in production until separate approval. With consistent reads off, existing multi-query snapshots do not have the stronger consistency guarantee.

The opt-in synthetic scale test extends the PostgreSQL parity fixture to **10,743 input rows per CCM**, with duplicate call-list rows, shared vehicles, and mixed workshop histories. It tests CRE and CCM viewers for two months, both loaders, both read modes, and actual fenced refreshes. It is not representative production data, an HTTP benchmark, a sustained concurrency test, or a full rollout certification. It inserts data and does not clean up: run it only against a fresh, disposable local PostgreSQL database named `snapshot_test_phase5_scale` on `127.0.0.1`. Prepare its schema separately, verify its connection identity, and do not point it at an existing environment. With the dedicated URL configured only in the test shell:

```powershell
$env:SNAPSHOT_INTEGRATION_DATABASE_URL = '<dedicated local disposable database URL>'
$env:SNAPSHOT_SCALE_TEST = 'true'
$env:TZ = 'Asia/Kolkata'
$env:WORKSHOP_TIMEZONE = 'Asia/Kolkata'
node --expose-gc --test tests\snapshotSlim.integration.test.js
```

Save the output and database identity with the review. The log reports per-operation wall time, process heap delta and database-driver query calls; heap delta is not peak memory and these calls are not necessarily individual server SQL statements. The fenced refresh emits phase timings, including the actual bounded consistent-read transaction. One run cannot establish p95 or p99, production capacity, or vacuum safety.

On 2026-11-14, a single local synthetic run on PostgreSQL 18.3 and Node 25.4.0 passed this test with 10,743 input rows per team. Team 0 had 10,329 canonical records and 63,571 visible visits. One CRE fenced refresh took 11,269 ms with the legacy loader and 1,730 ms with the slim loader; the consistent-read phases took 11,045 ms and 1,595 ms respectively. The corresponding driver query-call counts were 1,003 and 93. This is one sequential sample per loader with no concurrent write load, not a production estimate or a percentile. Separate smaller-fixture fencing and application-write concurrency tests passed; they do not establish behavior under production-scale contention.

Before rollout, use a separately provisioned isolated environment with approved, sanitized representative data and production-like PostgreSQL version, resources, pool sizes, workers, snapshot counts, history distributions, imports and write rates. Verify the largest relevant CRE workload has at least 10,743 input records, rather than only 10,743 spread across teams. Exercise real application writes and imports concurrently with multiple worker processes, including cross-CCM shared history, assignment changes, failed and partial imports, failed refreshes, and takeover immediately before publication.

Review gates:

1. All required Phase 2 and Phase 4 tests pass, including the legacy import integration suite and multi-process application-path contention; no missing invalidation, mixed clean publication, obsolete-worker publication, lost last-good value, unhandled deadlock, or role/metric mismatch is accepted.
2. Both loaders match exactly for every metric and role on stable representative data and satisfy the concurrent-write consistency and fencing tests. Verify timezone and month boundaries and Free-Service CRE behavior separately.
3. Run at least 100 measured refreshes per relevant loader/viewer combination after warm-up under representative load. Record total and consistent-read transaction p50/p95/p99 and maximum, timeout/failure/retry counts, dirty-to-clean latency, and snapshot freshness. Require zero timeouts and refresh failures attributable to the change; every current snapshot must remain within the existing 15-minute freshness limit, including during and after the write rehearsal. Treat an unbounded or continuously dirty workload as a failure, not a successful retry.
4. Require the measured maximum consistent-read duration to remain below the existing 60-second transaction deadline with an agreed operational safety margin. If it does not, stop and redesign input capture; do not extend the deadline solely to pass the test. Record pool acquisition waits, peak active connections across all processes, transaction age, vacuum/dead-tuple trends, database CPU and I/O, query counts/plans, worker peak RSS, source-write latency, deadlocks, and snapshot-row/revision write amplification. Review these against pre-approved environment-specific capacity limits; absence of limits or measurements is a failed gate.
5. Compare end-to-end endpoint latency and resource usage against the same environment with flags off, including normal traffic and representative concurrent writes. The controller benchmark below is supplemental only. Agree on and document acceptable p95/p99 regression limits before running; do not infer rollout readiness from a single synthetic sample.

After all gates pass, retain the evidence, review the additive migration and verified restore, quiesce every old worker, and obtain separate deployment approval. Apply and verify migrations only in the approved window, start the new version with experimental flags off, and validate maintenance, reconciliation, errors and freshness before separately approving flag changes. Do not run old and new workers together. Monitor the same latency, timeout, connection, vacuum, invalidation and freshness indicators through the agreed observation window.

If a gate fails or monitoring regresses, use the approved restart procedure to turn the slim flag off. Turning consistent reads off restores legacy mixed-read behavior, not the target guarantee: if that guarantee is required, disable snapshot-backed API reads as well. Stop all new workers before reverting application versions; retain the additive fencing schema unless a separately tested schema rollback is approved. Never delete source data as a rollback.

## Benchmarks

`scripts/performance/benchmark-performance-endpoints.mjs` compares the live and aggregate controller paths for:

- `/performance/summary` as a CRE
- `/performance/free-service` as a Free-Service CRE
- `/dashboard` as a CRE and a Free-Service CRE
- `/performance/board` as a CCM

It uses the guarded local bench connection, performs no writes, disables the response cache, alternates old/new execution order, and reports controller-level p50, p95, and mean latency. It is not a browser or HTTP/network benchmark. It refuses to run unless the aggregate tables exist and the current-month CRE and Free-Service CRE snapshots are fresh; it will not enqueue refreshes as benchmark work.

Run after the bench schema and derived data have been provisioned and validated:

```powershell
node scripts/performance/benchmark-performance-endpoints.mjs --iterations 20
```

Keep the database identity and the raw result with the review. Do not interpret timings as production measurements.

### Completed local bench run

The local bench was provisioned only after explicit approval. The aggregate migration was applied to `lakshmi_hyundai_crm_bench` on localhost (PostgreSQL 18.3, `Asia/Calcutta`); no production database was accessed. The idempotent backfill processed 12 callers, corrected 19,045 derived rows, reported zero failures, and seeded 28 pending snapshots. Read-only reconciliation then reported 0 mismatched rows and 0 orphaned snapshots.

The benchmark ran 20 old/new samples per controller path as `lh_bench_ro`, in read-only mode. These are measured local controller timings in milliseconds and exclude HTTP, browser, and network latency:

| Controller path | Old p50 / p95 / mean | Aggregate p50 / p95 / mean |
|---|---:|---:|
| `/performance/summary` (CRE) | 647.91 / 793.48 / 529.26 | 4.01 / 7.18 / 4.92 |
| `/performance/free-service` (FREE_SERVICE_CRE) | 3.55 / 5.64 / 3.99 | 2.39 / 3.24 / 2.52 |
| `/dashboard` (CRE) | 879.58 / 939.96 / 890.32 | 871.58 / 946.97 / 877.93 |
| `/dashboard` (FREE_SERVICE_CRE) | 3.20 / 4.21 / 3.26 | 1.91 / 3.61 / 2.13 |
| `/performance/board` (CCM) | 1.34 / 2.12 / 1.47 | 1.16 / 1.63 / 1.22 |

The CRE performance summary showed a large reduction in this local sample. The CRE dashboard remained effectively unchanged, so the aggregate path should not be claimed as a dashboard speedup based on this run. Other differences are small controller-level measurements and may be within local noise. PostgreSQL 18.3 and this synthetic bench dataset do not establish production performance or PostgreSQL 18.6 benchmark behavior.
