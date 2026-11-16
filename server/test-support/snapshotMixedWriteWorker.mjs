import { prisma } from '../src/config/prisma.js';
import { createCallLog } from '../src/controllers/callWorkflowController.js';
import { createManualCallListEntry, updateCallListAssignee } from '../src/controllers/recordsController.js';
import { setSnapshotRefreshHandler } from '../src/utils/performanceRefreshSignal.js';

const config = JSON.parse(process.env.SNAPSHOT_WRITE_CASE);
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
  process.send({ type: 'before-flush', pid });
  if (config.hold && (await nextCommand()).action !== 'release') {
    throw new Error('Expected release command');
  }
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
  if (config.kind === 'call') {
    await createCallLog({
      user: { id: config.creId, role: 'CRE', ccmId: config.ccmId },
      body: { customerId: config.customerId, vehicleId: config.vehicleId, outcome: 'CONTACTED' },
    }, response);
    if (response.statusCode !== 201) throw new Error(`Call returned ${response.statusCode}: ${JSON.stringify(response.body)}`);
  } else if (config.kind === 'assignment') {
    await updateCallListAssignee({
      user: { id: config.ccmUserId, role: 'CCM', ccmId: config.ccmId },
      params: { id: config.entryId }, body: { assigneeId: config.nextCreId },
    }, response);
    if (response.statusCode !== 200) throw new Error(`Assignment returned ${response.statusCode}: ${JSON.stringify(response.body)}`);
  } else if (config.kind === 'manual') {
    await createManualCallListEntry({
      user: { id: config.ccmUserId, role: 'CCM', ccmId: config.ccmId },
      body: {
        roNumber: config.roNumber, vin: config.vin, customerName: 'Customer', mobileNumber: '9000000000',
        visitDate: '2026-01-15', saleDate: '2025-01-15',
      },
    }, response);
    if (response.statusCode !== 201) throw new Error(`Manual entry returned ${response.statusCode}: ${JSON.stringify(response.body)}`);
  } else {
    throw new Error(`Unexpected write kind: ${config.kind}`);
  }
  process.send({ type: 'result', status: response.statusCode });
} catch (error) {
  process.send({ type: 'error', message: error.message });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  process.disconnect();
}
