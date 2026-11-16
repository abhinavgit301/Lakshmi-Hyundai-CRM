import { prisma } from '../src/config/prisma.js';
import { createFollowUp } from '../src/controllers/callWorkflowController.js';
import { setSnapshotRefreshHandler } from '../src/utils/performanceRefreshSignal.js';

const { ccmId, userId, customerId, holdRevision } = JSON.parse(process.env.SNAPSHOT_WRITE_CASE);
const commands = [];
let waiter;
process.on('message', (message) => {
  if (waiter) {
    const resolve = waiter;
    waiter = null;
    resolve(message);
  } else commands.push(message);
});
const nextCommand = () => commands.length ? Promise.resolve(commands.shift()) : new Promise((resolve) => { waiter = resolve; });
const transaction = prisma.$transaction.bind(prisma);
prisma.$transaction = (work, ...options) => transaction(async (tx) => {
  const result = await work(tx);
  const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
  if (holdRevision) {
    await tx.$queryRaw`SELECT "scope" FROM "performance_snapshot_revisions" WHERE "scope" = ${`ccm:${ccmId}`} FOR UPDATE`;
  }
  process.send({ type: holdRevision ? 'holding' : 'flushing', pid });
  if (holdRevision && (await nextCommand()).action !== 'release') throw new Error('Expected release command');
  return result;
}, ...options);
setSnapshotRefreshHandler(() => {});

try {
  process.send({ type: 'ready' });
  if ((await nextCommand()).action !== 'start') throw new Error('Expected start command');
  const response = {
    locals: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await createFollowUp({
    user: { id: userId, role: 'CCM', ccmId },
    body: { customerId, category: 'CALLBACK', followUpAt: new Date(Date.now() + 86400000).toISOString() },
  }, response);
  if (response.statusCode !== 201) throw new Error(`Follow-up returned ${response.statusCode}: ${JSON.stringify(response.body)}`);
  process.send({ type: 'result', status: response.statusCode });
} catch (error) {
  process.send({ type: 'error', message: error.message });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  process.disconnect();
}
