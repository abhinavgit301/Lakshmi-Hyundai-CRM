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

## Migration and initialization procedure

The migration is plain SQL and is intentionally not run at application startup. The viewer constraint includes `FREE_SERVICE_CRE` so those snapshot rows are valid.

1. Review the migration and rollback SQL. Take and verify a restorable database backup using the organization's established backup procedure.
2. Verify the intended database identity using a read-only connection first. Confirm the database name, server, timezone, and that it is not production unless a separately approved production change is underway.
3. During an approved rollout window, apply `prisma/migrations/20261113000000_performance_aggregates/migration.sql` exactly once with `psql -v ON_ERROR_STOP=1`. Do not use `prisma db push` or a reset command.
4. Verify both tables and indexes exist, including the snapshot primary key over the five key columns. Verify the viewer check accepts `CRE`, `CCM`, and `FREE_SERVICE_CRE`.
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

## Rollback

Rollback removes only derived aggregate/snapshot tables. It does not alter source CRM records.

1. Set `PERFORMANCE_AGGREGATES_ENABLED=false` and `PERFORMANCE_AGGREGATES_MAINTAIN=false`, then restart the backend. Verify logs show the scheduler is not active and the legacy API path is serving requests.
2. Verify the exact database identity again and ensure no application instance still depends on the aggregate tables.
3. Apply `prisma/migrations/20261113000000_performance_aggregates/rollback.sql` with `psql -v ON_ERROR_STOP=1` on the same approved target.
4. Verify both derived tables are absent and legacy CRM endpoints still work.
5. Keep the migration source files for a future controlled re-application. Re-application requires recreating and backfilling the derived tables before enabling reads.

Do not roll back by deleting customer, vehicle, CallLog, import, or ownership data. Do not run `prisma migrate reset`, `prisma db push --force-reset`, or an automatic migration command.

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
