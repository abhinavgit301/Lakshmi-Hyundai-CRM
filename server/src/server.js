import 'dotenv/config';
import app from './app.js';
import { ensureFirstAdmin } from './config/seedAdmin.js';
import { ensureDemoUsers } from './config/seedDemoUsers.js';
import { backfillVehicleSaleDates } from './config/backfillSaleDates.js';
import { repairFreeServiceCreAssignments } from './utils/customerAllocation.js';
import { prisma } from './config/prisma.js';

const port = Number(process.env.PORT || 4000);

async function startServer() {
  await ensureFirstAdmin();
  await ensureDemoUsers();
  const repairedAssignments = await prisma.$transaction((transaction) => repairFreeServiceCreAssignments(transaction));
  if (repairedAssignments) console.log(`Reassigned ${repairedAssignments} Master Call List records away from Free-Service CRE accounts.`);
  const backfilled = await backfillVehicleSaleDates();
  if (backfilled) console.log(`Backfilled sale dates for ${backfilled} vehicles.`);

  app.listen(port, () => {
    console.log(`Lakshmi Hyundai CRM API listening on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
