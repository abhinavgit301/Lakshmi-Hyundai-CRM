import 'dotenv/config';
import app from './app.js';
import { backfillVehicleSaleDates } from './config/backfillSaleDates.js';
import { repairFreeServiceCreAssignments } from './utils/customerAllocation.js';
import { prisma } from './config/prisma.js';
import { assertProcessMatchesWorkshopTimezone } from './utils/workshopTime.js';
import { startPerformanceSnapshotScheduler } from './services/performanceSnapshotService.js';

const port = Number(process.env.PORT || 4000);

async function runStartupRepairs() {
  const repairedAssignments = await prisma.$transaction((transaction) => repairFreeServiceCreAssignments(transaction));
  if (repairedAssignments) console.log(`Reassigned ${repairedAssignments} Master Call List records away from Free-Service CRE accounts.`);
  const backfilled = await backfillVehicleSaleDates();
  if (backfilled) console.log(`Backfilled sale dates for ${backfilled} vehicles.`);
}

// Startup repairs write to the database, so they only run when RUN_STARTUP_REPAIRS is "true" (case-insensitive).
function isStartupRepairsEnabled(env = process.env) {
  return String(env.RUN_STARTUP_REPAIRS ?? '').trim().toLowerCase() === 'true';
}

async function startServer() {
  // Must run before listening and before any date-sensitive startup work.
  const timezone = assertProcessMatchesWorkshopTimezone();
  console.log(`Workshop timezone: configured=${timezone.configured} process=${timezone.effective} (canonical ${timezone.canonical})`);

  // Listen first so cold starts do not wait on the repairs.
  app.listen(port, () => {
    console.log(`Lakshmi Hyundai CRM API listening on http://localhost:${port}`);
  });

  if (startPerformanceSnapshotScheduler()) {
    console.log('Performance snapshot scheduler started (PERFORMANCE_AGGREGATES_MAINTAIN or _ENABLED is true).');
  }

  if (isStartupRepairsEnabled()) {
    console.log('Startup repairs enabled (RUN_STARTUP_REPAIRS=true): running Free-Service CRE reassignment and sale-date backfill.');
    runStartupRepairs().catch((error) => {
      console.error('Startup repairs failed:', error);
    });
  } else {
    console.log('Startup repairs skipped (RUN_STARTUP_REPAIRS is not "true"). No database repairs were run at startup.');
  }
}

startServer().catch((error) => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
