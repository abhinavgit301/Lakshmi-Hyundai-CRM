BEGIN;

-- Immediate tier: daily call counts maintained by the application inside the CallLog write transaction.
CREATE TABLE "cre_call_daily" (
  "userId" TEXT NOT NULL,
  "ccmId" TEXT NOT NULL,
  "workshopDate" DATE NOT NULL,
  "callSource" "CallSource" NOT NULL,
  "scopeKind" TEXT NOT NULL,
  "calls" INTEGER NOT NULL DEFAULT 0,
  "answeredCalls" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cre_call_daily_pkey" PRIMARY KEY ("userId", "ccmId", "workshopDate", "callSource", "scopeKind"),
  CONSTRAINT "cre_call_daily_scopeKind_check" CHECK ("scopeKind" IN ('OWNED', 'TEAM')),
  CONSTRAINT "cre_call_daily_nonnegative_check" CHECK ("calls" >= 0 AND "answeredCalls" >= 0 AND "answeredCalls" <= "calls")
);

CREATE INDEX "cre_call_daily_ccmId_workshopDate_idx" ON "cre_call_daily" ("ccmId", "workshopDate");

-- Snapshot tier: persisted dashboard metrics with freshness and failure tracking.
CREATE TABLE "cre_performance_snapshots" (
  "creId" TEXT NOT NULL,
  "ccmId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "viewer" TEXT NOT NULL,
  "callsThisMonth" INTEGER,
  "assignedCustomerCount" INTEGER,
  "pendingFollowUps" INTEGER,
  "dueServicesCount" INTEGER,
  "missedWarrantyCount" INTEGER,
  "details" JSONB,
  "cycleStartedAt" TIMESTAMP(3),
  "asOf" TIMESTAMP(3),
  "computedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'pending',
  "dirtySince" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "refreshStartedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cre_performance_snapshots_pkey" PRIMARY KEY ("creId", "ccmId", "year", "month", "viewer"),
  CONSTRAINT "cre_performance_snapshots_viewer_check" CHECK ("viewer" IN ('CRE', 'CCM', 'FREE_SERVICE_CRE')),
  CONSTRAINT "cre_performance_snapshots_status_check" CHECK ("status" IN ('pending', 'ok', 'dirty', 'refreshing', 'failed'))
);

CREATE INDEX "cre_performance_snapshots_status_computedAt_idx" ON "cre_performance_snapshots" ("status", "computedAt");
CREATE INDEX "cre_performance_snapshots_ccmId_year_month_idx" ON "cre_performance_snapshots" ("ccmId", "year", "month");

-- Tables are created empty. Populate them with scripts/performance/backfill-performance-aggregates.mjs.
COMMIT;
