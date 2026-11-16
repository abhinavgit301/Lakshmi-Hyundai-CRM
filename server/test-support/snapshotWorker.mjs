import { prisma } from '../src/config/prisma.js';
import { refreshSnapshot } from '../src/services/performanceSnapshotService.js';

const { key, now, calls } = JSON.parse(process.env.SNAPSHOT_WORKER_CASE);
const command = new Promise((resolve) => process.once('message', resolve));

try {
  const result = await refreshSnapshot(key, {
    now: new Date(now),
    compute: async () => async () => {
      process.send({ type: 'ready' });
      const { action } = await command;
      if (action === 'fail') throw new Error('forced worker failure');
      return { callsThisMonth: calls, details: {}, asOf: new Date(now) };
    },
  });
  process.send({ type: 'result', result: { refreshed: result.refreshed, reason: result.reason } });
} catch (error) {
  process.send({ type: 'error', message: error.message });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  process.disconnect();
}
