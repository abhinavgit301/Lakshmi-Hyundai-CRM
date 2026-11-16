import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { reconcileFreeServiceMilestones } from '../src/utils/reconcileFreeServiceMilestones.js';

const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--maintenance-window'].includes(arg))
  || new Set(args).size !== args.length
  || !args.includes('--maintenance-window')) {
  throw new Error('Stop all application writers, then use --maintenance-window for a dry run or --apply --maintenance-window to apply.');
}

try {
  const result = await reconcileFreeServiceMilestones(prisma, { apply: args.includes('--apply') });
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', ...result }, null, 2));
  if (result.unresolved.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
