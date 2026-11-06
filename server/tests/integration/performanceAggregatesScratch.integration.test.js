import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

const databaseUrl = process.env.PERFORMANCE_AGGREGATES_TEST_DATABASE_URL;
let prisma;
let addCallToAggregates;
let noteCreDeleted;
let noteCreCallEntityScopeChange;
let noteCreAccountChangeIfAffected;
let recordCreAssignmentEvent;
let aggregateScopeWhere;
let getCreCallCounts;
let readCreCallCounts;
let refreshSnapshot;
let rollbackImportBatch;
let identity;
let fixture;

if (!databaseUrl) {
  test('performance aggregate mutations require an isolated PG18.6 scratch URL', { skip: true }, () => {});
} else {
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())
    || parsed.port !== '55436'
    || decodeURIComponent(parsed.pathname.slice(1)) !== 'performance_aggregates_scratch'
    || parsed.searchParams.has('options')) {
    throw new Error('PERFORMANCE_AGGREGATES_TEST_DATABASE_URL must target localhost:55436/performance_aggregates_scratch.');
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';

  before(async () => {
    [{ prisma }, { addCallToAggregates, noteCreDeleted, noteCreCallEntityScopeChange, noteCreAccountChangeIfAffected }, { recordCreAssignmentEvent }, { aggregateScopeWhere }, { getCreCallCounts }, { readCreCallCounts }, { refreshSnapshot }, { rollbackImportBatch }] = await Promise.all([
      import('../../src/config/prisma.js'),
      import('../../src/utils/creCallAggregates.js'),
      import('../../src/utils/creAssignmentHistory.js'),
      import('../../src/utils/creCallAggregates.js'),
      import('../../src/utils/callMetrics.js'),
      import('../../src/utils/creCallAggregateReaders.js'),
      import('../../src/services/performanceSnapshotService.js'),
      import('../../src/services/importRollbackService.js'),
    ]);
    [identity] = await prisma.$queryRaw`
      SELECT current_database() AS database, current_user AS username,
        inet_server_addr()::text AS server_address, current_setting('server_version') AS server_version,
        current_setting('default_transaction_read_only') AS read_only
    `;
    assert.equal(identity.database, 'performance_aggregates_scratch');
    assert.equal(identity.read_only, 'off');
    assert.match(identity.server_version, /^18\.6(?:\s|$)/);
    fixture = {
      suffix: randomUUID().replaceAll('-', ''),
      ccmId: `scratch-ccm-${randomUUID()}`,
      now: new Date(),
    };
    fixture.creA = `scratch-cre-a-${fixture.suffix}`;
    fixture.creB = `scratch-cre-b-${fixture.suffix}`;
    fixture.customerId = `scratch-customer-${fixture.suffix}`;
    fixture.physicalVehicleId = `scratch-physical-${fixture.suffix}`;
    fixture.vehicleId = `scratch-vehicle-${fixture.suffix}`;
    fixture.allocationId = `scratch-allocation-${fixture.suffix}`;
    fixture.masterCallListId = `scratch-mcl-${fixture.suffix}`;
    fixture.importBatchId = `scratch-import-${fixture.suffix}`;
    fixture.importRowProgressId = `scratch-progress-${fixture.suffix}`;
    fixture.importChangeId = `scratch-change-${fixture.suffix}`;
    fixture.callId = `scratch-call-${fixture.suffix}`;
    fixture.customerOnlyCallId = `scratch-customer-call-${fixture.suffix}`;

    await prisma.user.createMany({
      data: [
        { id: fixture.creA, name: 'Scratch CRE A', password: 'scratch-only', role: 'CRE', ccmId: fixture.ccmId },
        { id: fixture.creB, name: 'Scratch CRE B', password: 'scratch-only', role: 'CRE', ccmId: fixture.ccmId },
      ],
    });
    await prisma.customer.create({
      data: {
        id: fixture.customerId,
        customerCode: fixture.customerId,
        fullName: 'Scratch Customer',
        ccmId: fixture.ccmId,
      },
    });
    await prisma.physicalVehicle.create({
      data: { id: fixture.physicalVehicleId, vin: `${fixture.suffix.slice(0, 17)}` },
    });
    await prisma.vehicle.create({
      data: {
        id: fixture.vehicleId,
        vin: `${fixture.suffix.slice(0, 17)}`,
        physicalVehicleId: fixture.physicalVehicleId,
        model: 'Scratch Vehicle',
        customerId: fixture.customerId,
        ccmId: fixture.ccmId,
      },
    });
    await prisma.allocation.create({
      data: {
        id: fixture.allocationId,
        vehicleId: fixture.vehicleId,
        creId: fixture.creA,
        ccmId: fixture.ccmId,
        serviceType: 'SERVICE',
        status: 'assigned',
      },
    });
    await prisma.masterCallList.create({
      data: {
        id: fixture.masterCallListId,
        customerName: 'Scratch Customer',
        mobileNumber: '9999999999',
        vin: `${fixture.suffix.slice(0, 17)}`,
        ccmId: fixture.ccmId,
        ownerUserId: fixture.creA,
        vehicleId: fixture.vehicleId,
      },
    });
    await prisma.$transaction(async (transaction) => {
      const call = await transaction.callLog.create({
        data: {
          id: fixture.callId,
          customerId: fixture.customerId,
          vehicleId: fixture.vehicleId,
          ccmId: fixture.ccmId,
          assignedToId: fixture.creA,
          createdById: fixture.creA,
          outcome: 'APPOINTMENT_SET',
          callSource: 'SERVICE',
          createdAt: fixture.now,
        },
      });
      await addCallToAggregates(transaction, call);
      const customerOnlyCall = await transaction.callLog.create({
        data: {
          id: fixture.customerOnlyCallId,
          customerId: fixture.customerId,
          ccmId: fixture.ccmId,
          assignedToId: fixture.creA,
          createdById: fixture.creA,
          outcome: 'CONTACTED',
          callSource: 'SERVICE',
          createdAt: fixture.now,
        },
      });
      await addCallToAggregates(transaction, customerOnlyCall);
    });
  });

  after(async () => {
    if (!prisma) return;
    if (fixture) {
      await prisma.$transaction(async (transaction) => {
        await transaction.crePerformanceSnapshot.deleteMany({ where: { creId: { in: [fixture.creA, fixture.creB] } } });
        await transaction.creCallDaily.deleteMany({ where: { userId: { in: [fixture.creA, fixture.creB] } } });
        await transaction.callLog.deleteMany({ where: { id: { in: [fixture.callId, fixture.customerOnlyCallId, ...(fixture.failedCallId ? [fixture.failedCallId] : [])] } } });
        await transaction.masterCallList.deleteMany({ where: { id: fixture.masterCallListId } });
        await transaction.importBatch.deleteMany({ where: { id: fixture.importBatchId } });
        await transaction.allocation.deleteMany({ where: { id: fixture.allocationId } });
        await transaction.vehicle.deleteMany({ where: { id: fixture.vehicleId } });
        await transaction.customer.deleteMany({ where: { id: fixture.customerId } });
        await transaction.physicalVehicle.deleteMany({ where: { id: fixture.physicalVehicleId } });
        await transaction.user.deleteMany({ where: { id: { in: [fixture.creA, fixture.creB] } } });
      });
    }
    await prisma.$disconnect();
  });

  async function assertCounterParity(userId, kind, ccmId = fixture.ccmId) {
    const start = new Date('2026-11-06T00:00:00.000Z');
    const end = new Date('2026-11-07T00:00:00.000Z');
    const live = (await getCreCallCounts({
      creIds: [userId],
      start,
      end,
      ccmId,
      scopeWhere: aggregateScopeWhere(kind, { userId, ccmId }),
    })).get(userId);
    const aggregate = await readCreCallCounts({
      userId,
      ccmId,
      kind,
      start,
      end,
    });
    assert.deepEqual(aggregate, live, `${kind} counter mismatch for ${userId}`);
    return live;
  }

  test('PG18.6 mutations keep counters, ownership changes, rollbacks and refresh concurrency consistent', async () => {
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 2, callsPickedUp: 2 });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'TEAM'), { callsMade: 2, callsPickedUp: 2 });

    fixture.failedCallId = `scratch-failed-call-${fixture.suffix}`;
    await assert.rejects(prisma.$transaction(async (transaction) => {
      const call = await transaction.callLog.create({
        data: {
          id: fixture.failedCallId,
          customerId: fixture.customerId,
          vehicleId: fixture.vehicleId,
          ccmId: fixture.ccmId,
          assignedToId: fixture.creA,
          createdById: fixture.creA,
          outcome: 'CONTACTED',
          callSource: 'SERVICE',
          createdAt: fixture.now,
        },
      });
      await addCallToAggregates(transaction, call);
      throw new Error('intentional scratch transaction rollback');
    }), /intentional scratch transaction rollback/);
    assert.equal(await prisma.callLog.count({ where: { id: fixture.failedCallId } }), 0);
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 2, callsPickedUp: 2 });

    const key = { creId: fixture.creA, ccmId: fixture.ccmId, year: 2026, month: 11, viewer: 'CRE' };
    let releaseCompute;
    let startCompute;
    const computeGate = new Promise((resolve) => { releaseCompute = resolve; });
    const computeStarted = new Promise((resolve) => { startCompute = resolve; });
    const refresh = refreshSnapshot(key, {
      now: new Date(),
      compute: async () => {
        startCompute();
        await computeGate;
        return {
          callsThisMonth: 2,
          assignedCustomerCount: 1,
          pendingFollowUps: 0,
          dueServicesCount: 0,
          missedWarrantyCount: null,
          cycleStartedAt: new Date('2026-11-01T00:00:00.000Z'),
          asOf: fixture.now,
          details: { lifetimeCalls: 2 },
        };
      },
    });
    await computeStarted;
    const concurrent = await refreshSnapshot(key, { compute: async () => { throw new Error('second refresh must not run'); } });
    assert.deepEqual(concurrent, { refreshed: false, reason: 'already-refreshing' });

    await prisma.$transaction(async (transaction) => {
      await transaction.allocation.update({ where: { id: fixture.allocationId }, data: { creId: fixture.creB } });
      await transaction.masterCallList.update({ where: { id: fixture.masterCallListId }, data: { ownerUserId: fixture.creB } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: fixture.vehicleId,
        allocationId: fixture.allocationId,
        masterCallListId: fixture.masterCallListId,
        ccmId: fixture.ccmId,
        previousCreId: fixture.creA,
        newCreId: fixture.creB,
        eventType: 'REASSIGNED',
      });
    });
    releaseCompute();
    assert.equal((await refresh).refreshed, true);
    const dirtySnapshot = await prisma.crePerformanceSnapshot.findUnique({
      where: { creId_ccmId_year_month_viewer: key },
    });
    assert.equal(dirtySnapshot.status, 'dirty');
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 0, callsPickedUp: 0 });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'TEAM'), { callsMade: 2, callsPickedUp: 2 });

    await prisma.$transaction(async (transaction) => {
      await transaction.allocation.update({ where: { id: fixture.allocationId }, data: { status: 'unassigned' } });
      await transaction.masterCallList.update({ where: { id: fixture.masterCallListId }, data: { ownerUserId: null } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: fixture.vehicleId,
        allocationId: fixture.allocationId,
        masterCallListId: fixture.masterCallListId,
        ccmId: fixture.ccmId,
        previousCreId: fixture.creB,
        newCreId: null,
        eventType: 'UNASSIGNED',
      });
    });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 0, callsPickedUp: 0 });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'TEAM'), { callsMade: 2, callsPickedUp: 2 });

    await prisma.$transaction(async (transaction) => {
      await transaction.masterCallList.update({ where: { id: fixture.masterCallListId }, data: { ownerUserId: fixture.creA } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: fixture.vehicleId,
        masterCallListId: fixture.masterCallListId,
        ccmId: fixture.ccmId,
        previousCreId: null,
        newCreId: fixture.creA,
        eventType: 'ASSIGNED',
      });
    });
    const importBefore = await prisma.masterCallList.findUnique({ where: { id: fixture.masterCallListId } });
    await prisma.$transaction(async (transaction) => {
      await transaction.masterCallList.update({ where: { id: fixture.masterCallListId }, data: { ownerUserId: fixture.creB } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: fixture.vehicleId,
        masterCallListId: fixture.masterCallListId,
        ccmId: fixture.ccmId,
        previousCreId: fixture.creA,
        newCreId: fixture.creB,
        eventType: 'REASSIGNED',
      });
    });
    const importAfter = await prisma.masterCallList.findUnique({ where: { id: fixture.masterCallListId } });
    await prisma.importBatch.create({
      data: {
        id: fixture.importBatchId,
        fileName: 'scratch-import.csv',
        importType: 'repair_order',
        ccmId: fixture.ccmId,
        totalRows: 1,
        processedRows: 1,
        status: 'completed',
        rollbackSupported: true,
        allocationEvidenceState: 'complete',
        allocationChangeCount: 1,
        rowProgress: {
          create: {
            id: fixture.importRowProgressId,
            rowNumber: 2,
            status: 'completed',
            outcome: 'skipped',
            mutationState: 'complete',
            loggedChangeCount: 0,
          },
        },
      },
    });
    await prisma.importChangeLog.create({
      data: {
        id: fixture.importChangeId,
        importBatchId: fixture.importBatchId,
        evidenceScope: 'batch',
        sequence: 1,
        entityType: 'MasterCallList',
        entityId: fixture.masterCallListId,
        ccmId: fixture.ccmId,
        operation: 'UPDATE',
        before: { ownerUserId: fixture.creA, updatedAt: importBefore.updatedAt.toISOString() },
        after: { ownerUserId: fixture.creB, updatedAt: importAfter.updatedAt.toISOString() },
      },
    });
    const rollbackResult = await rollbackImportBatch(fixture.importBatchId, null);
    assert.equal(rollbackResult.batch.status, 'rolled_back');
    assert.equal((await prisma.masterCallList.findUnique({ where: { id: fixture.masterCallListId } })).ownerUserId, fixture.creA);
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 2, callsPickedUp: 2 });

    await prisma.$transaction(async (transaction) => {
      await transaction.allocation.delete({ where: { id: fixture.allocationId } });
      await recordCreAssignmentEvent(transaction, {
        vehicleId: fixture.vehicleId,
        masterCallListId: fixture.masterCallListId,
        ccmId: fixture.ccmId,
        previousCreId: fixture.creA,
        newCreId: null,
        eventType: 'UNASSIGNED',
      });
      await transaction.masterCallList.delete({ where: { id: fixture.masterCallListId } });
      await noteCreCallEntityScopeChange(transaction, { vehicleIds: [fixture.vehicleId] });
      await transaction.vehicle.update({
        where: { id: fixture.vehicleId },
        data: { ccmId: 'scratch-new-vehicle-ccm' },
      });
    });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 0, callsPickedUp: 0 });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'TEAM'), { callsMade: 1, callsPickedUp: 1 });

    await prisma.$transaction(async (transaction) => {
      await noteCreCallEntityScopeChange(transaction, { vehicleIds: [fixture.vehicleId] });
      await transaction.vehicle.delete({ where: { id: fixture.vehicleId } });
    });
    assert.equal((await prisma.callLog.findUnique({ where: { id: fixture.callId } })).vehicleId, null);
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 0, callsPickedUp: 0 });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'TEAM'), { callsMade: 2, callsPickedUp: 2 });

    await prisma.$transaction(async (transaction) => {
      const before = await transaction.customer.findUnique({ where: { id: fixture.customerId } });
      await noteCreCallEntityScopeChange(transaction, { customerIds: [fixture.customerId] });
      await transaction.customer.update({ where: { id: fixture.customerId }, data: { ccmId: 'scratch-new-ccm' } });
      assert.equal(before.ccmId, fixture.ccmId);
    });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'TEAM'), { callsMade: 0, callsPickedUp: 0 });
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED'), { callsMade: 0, callsPickedUp: 0 });

    const rowsBeforeRejectedCustomerDelete = await prisma.creCallDaily.findMany({ where: { userId: fixture.creA } });
    await assert.rejects(prisma.$transaction(async (transaction) => {
      await noteCreCallEntityScopeChange(transaction, { customerIds: [fixture.customerId] });
      await transaction.customer.delete({ where: { id: fixture.customerId } });
    }));
    assert.ok(await prisma.customer.findUnique({ where: { id: fixture.customerId } }));
    assert.deepEqual(await prisma.creCallDaily.findMany({ where: { userId: fixture.creA } }), rowsBeforeRejectedCustomerDelete);

    await prisma.$transaction(async (transaction) => {
      const before = await transaction.user.findUnique({ where: { id: fixture.creA } });
      const after = await transaction.user.update({ where: { id: fixture.creA }, data: { ccmId: 'scratch-transferred-ccm' } });
      noteCreAccountChangeIfAffected(transaction, before, after);
    });
    assert.equal(await prisma.crePerformanceSnapshot.findUnique({ where: { creId_ccmId_year_month_viewer: key } }), null);
    assert.deepEqual(await assertCounterParity(fixture.creA, 'OWNED', 'scratch-transferred-ccm'), { callsMade: 0, callsPickedUp: 0 });

    await prisma.$transaction(async (transaction) => {
      noteCreDeleted(transaction, { creId: fixture.creA });
      await transaction.user.delete({ where: { id: fixture.creA } });
    });
    assert.equal(await prisma.creCallDaily.count({ where: { userId: fixture.creA } }), 0);
  });
}
