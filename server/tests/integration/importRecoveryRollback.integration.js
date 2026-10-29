import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { configureTestDatabaseUrl, validateTestDatabaseUrl } from './testDatabaseConfig.js';

configureTestDatabaseUrl(process.env.TEST_DATABASE_URL);

const [
  { prisma },
  { rollbackImportBatch, ImportRollbackConflict },
  { recoverAbandonedImport, ImportRecoveryConflict },
  { acquireImportProcessingLock, assertImportBatchProcessing },
  { recordImportChange },
  { importBatchMutationEvidenceIsComplete },
  { allocateUnassignedMasterCallListEntries },
  { importRepairOrders },
] = await Promise.all([
  import('../../src/config/prisma.js'),
  import('../../src/services/importRollbackService.js'),
  import('../../src/services/importRecoveryService.js'),
  import('../../src/utils/importProcessingLock.js'),
  import('../../src/utils/importChangeLog.js'),
  import('../../src/utils/importBatchStats.js'),
  import('../../src/utils/customerAllocation.js'),
  import('../../src/controllers/importController.js'),
]);

const runPrefix = `it_${randomUUID().replaceAll('-', '')}`;
const ownedBatchIds = new Set();
const ownedCustomerIds = new Set();
const ownedVehicleIds = new Set();
const ownedVisitIds = new Set();
const ownedCallListIds = new Set();
const ownedUserIds = new Set();

function nextId(label) {
  return `${runPrefix}_${label}_${randomUUID().replaceAll('-', '')}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function startBarrierDatabase(database, participants, onTransaction) {
  let arrivals = 0;
  const ready = deferred();
  return {
    $transaction(callback, options) {
      arrivals += 1;
      if (arrivals === participants) ready.resolve();
      return ready.promise.then(() => database.$transaction(async (transaction) => {
        await onTransaction?.(transaction);
        return callback(transaction);
      }, options));
    },
  };
}

function proxyTransaction(transaction, wrapDelegate) {
  return new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === 'string' && value && typeof value === 'object'
        && ['customer', 'vehicle', 'workshopVisit', 'masterCallList', 'allocation'].includes(property)) {
        return wrapDelegate(property, value);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrappedDatabase(database, wrapDelegate) {
  return {
    $transaction(callback, options) {
      return database.$transaction(
        (transaction) => callback(proxyTransaction(transaction, wrapDelegate)),
        options,
      );
    },
  };
}

async function createBatch({
  status = 'completed',
  outcome = 'created',
  rollbackSupported = true,
  totalRows = 1,
  processedRows = 1,
} = {}) {
  const id = nextId('batch');
  const progressId = nextId('progress');
  ownedBatchIds.add(id);
  const batch = await prisma.importBatch.create({
    data: {
      id,
      fileName: 'postgres-import-integration.csv',
      status,
      totalRows,
      processedRows,
      rollbackSupported,
      statsComplete: true,
      affectedCountsComplete: rollbackSupported,
      rowProgress: {
        create: {
          id: progressId,
          rowNumber: 2,
          status: 'completed',
          outcome,
          mutationState: 'complete',
          loggedChangeCount: 0,
        },
      },
    },
    include: { rowProgress: true },
  });
  return { batch, progress: batch.rowProgress[0] };
}

async function createBusinessFixture({
  batchStatus = 'completed',
  outcome = 'created',
  includeCallList = false,
  rollbackSupported = true,
} = {}) {
  const { batch, progress } = await createBatch({ status: batchStatus, outcome, rollbackSupported });
  const customerId = nextId('customer');
  const vehicleId = nextId('vehicle');
  const visitId = nextId('visit');
  ownedCustomerIds.add(customerId);
  ownedVehicleIds.add(vehicleId);
  ownedVisitIds.add(visitId);

  const records = await prisma.$transaction(async (transaction) => {
    const customer = await transaction.customer.create({
      data: {
        id: customerId,
        customerCode: nextId('code'),
        fullName: 'Integration Customer',
        mobileNumber: '9000000000',
        ccmId: nextId('ccm'),
      },
    });
    const vehicle = await transaction.vehicle.create({
      data: {
        id: vehicleId,
        vin: nextId('vin'),
        customerId,
        ccmId: customer.ccmId,
      },
    });
    const visit = await transaction.workshopVisit.create({
      data: {
        id: visitId,
        repairOrderNo: nextId('ro'),
        customerId,
        vehicleId,
        ccmId: customer.ccmId,
        importedDetails: {},
      },
    });
    const changes = [
      ['Customer', customer],
      ['Vehicle', vehicle],
      ['WorkshopVisit', visit],
    ];
    let sequence = 0;
    for (const [entityType, record] of changes) {
      await recordImportChange(transaction, {
        importBatchId: batch.id,
        rowProgressId: progress.id,
        sequence: ++sequence,
        entityType,
        entityId: record.id,
        ccmId: customer.ccmId,
        operation: 'CREATE',
        before: {},
        after: record,
      });
    }

    let callList = null;
    if (includeCallList) {
      const callListId = nextId('call');
      ownedCallListIds.add(callListId);
      callList = await transaction.masterCallList.create({
        data: {
          id: callListId,
          customerName: customer.fullName,
          mobileNumber: customer.mobileNumber,
          vin: vehicle.vin,
          ccmId: customer.ccmId,
        },
      });
      await recordImportChange(transaction, {
        importBatchId: batch.id,
        rowProgressId: progress.id,
        sequence: ++sequence,
        entityType: 'MasterCallList',
        entityId: callList.id,
        ccmId: customer.ccmId,
        operation: 'CREATE',
        before: {},
        after: callList,
      });
    }
    await transaction.importRowProgress.update({
      where: { id: progress.id },
      data: { loggedChangeCount: sequence },
    });
    return { customer, vehicle, visit, callList, sequence };
  });
  return { batch, progress, ...records };
}

async function updateVehicleWithEvidence(transaction, fixture, sequence) {
  const before = {
    saleDate: fixture.vehicle.saleDate,
    updatedAt: fixture.vehicle.updatedAt,
  };
  const after = await transaction.vehicle.update({
    where: { id: fixture.vehicle.id },
    data: {
      saleDate: new Date('2026-01-15T00:00:00.000Z'),
      updatedAt: new Date('2026-02-15T00:00:00.000Z'),
    },
  });
  await recordImportChange(transaction, {
    importBatchId: fixture.batch.id,
    rowProgressId: fixture.progress.id,
    sequence,
    entityType: 'Vehicle',
    entityId: fixture.vehicle.id,
    ccmId: fixture.customer.ccmId,
    operation: 'UPDATE',
    before,
    after: { saleDate: after.saleDate, updatedAt: after.updatedAt },
  });
  await transaction.importRowProgress.update({
    where: { id: fixture.progress.id },
    data: { loggedChangeCount: sequence },
  });
  return after;
}

async function applyBatchAllocation(transaction, fixture, sequence) {
  let nextSequence = sequence;
  let allocationChangeCount = 0;
  await allocateUnassignedMasterCallListEntries(
    transaction,
    fixture.customer.ccmId,
    null,
    {
      onMutation: async (change, update) => {
        const updated = await update();
        await recordImportChange(transaction, {
          importBatchId: fixture.batch.id,
          rowProgressId: null,
          evidenceScope: 'batch',
          sequence: ++nextSequence,
          entityType: change.entityType,
          entityId: change.entityId,
          ccmId: change.ccmId,
          operation: 'UPDATE',
          before: change.before,
          after: {
            [change.entityType === 'MasterCallList' ? 'ownerUserId' : 'creId']:
              change.entityType === 'MasterCallList' ? updated.ownerUserId : updated.creId,
            updatedAt: updated.updatedAt,
          },
        });
        allocationChangeCount += 1;
      },
    },
  );
  await transaction.importBatch.update({
    where: { id: fixture.batch.id },
    data: { allocationEvidenceState: 'complete', allocationChangeCount },
  });
}

async function createActiveCre(ccmId) {
  return createCre(ccmId, 'active');
}

async function createCre(ccmId, status) {
  const id = nextId('cre');
  ownedUserIds.add(id);
  return prisma.user.create({
    data: {
      id,
      name: 'Integration CRE',
      password: 'integration-only-placeholder',
      role: 'CRE',
      ccmId,
      status,
    },
  });
}

async function createImportActor() {
  const id = nextId('ccm-user');
  const ccmId = nextId('ccm');
  ownedUserIds.add(id);
  return prisma.user.create({
    data: {
      id,
      name: 'Integration Import CCM',
      password: 'integration-only-placeholder',
      role: 'CCM',
      ccmId,
      status: 'active',
    },
  });
}

async function createAllocationFixture() {
  const ccmId = nextId('ccm');
  const customerId = nextId('customer');
  const vehicleId = nextId('vehicle');
  const visitId = nextId('visit');
  const callListId = nextId('call');
  const allocationId = nextId('allocation');
  ownedCustomerIds.add(customerId);
  ownedVehicleIds.add(vehicleId);
  ownedVisitIds.add(visitId);
  ownedCallListIds.add(callListId);

  const customer = await prisma.customer.create({
    data: {
      id: customerId,
      customerCode: nextId('code'),
      fullName: 'Existing Integration Customer',
      mobileNumber: '9222222222',
      ccmId,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: { id: vehicleId, vin: nextId('vin'), customerId, ccmId },
  });
  const activeCre = await createActiveCre(ccmId);
  const inactiveCre = await createCre(ccmId, 'inactive');
  const allocation = await prisma.allocation.create({
    data: {
      id: allocationId,
      vehicleId,
      creId: inactiveCre.id,
      ccmId,
      serviceType: 'integration-test',
      status: 'assigned',
    },
  });
  const { batch, progress } = await createBatch({ outcome: 'appended' });
  const records = await prisma.$transaction(async (transaction) => {
    const visit = await transaction.workshopVisit.create({
      data: {
        id: visitId,
        repairOrderNo: nextId('ro'),
        customerId,
        vehicleId,
        ccmId,
        importedDetails: {},
      },
    });
    const callList = await transaction.masterCallList.create({
      data: {
        id: callListId,
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber,
        vin: vehicle.vin,
        ccmId,
      },
    });
    await recordImportChange(transaction, {
      importBatchId: batch.id,
      rowProgressId: progress.id,
      sequence: 1,
      entityType: 'WorkshopVisit',
      entityId: visit.id,
      ccmId,
      operation: 'CREATE',
      before: {},
      after: visit,
    });
    await recordImportChange(transaction, {
      importBatchId: batch.id,
      rowProgressId: progress.id,
      sequence: 2,
      entityType: 'MasterCallList',
      entityId: callList.id,
      ccmId,
      operation: 'CREATE',
      before: {},
      after: callList,
    });
    await transaction.importRowProgress.update({
      where: { id: progress.id },
      data: { loggedChangeCount: 2 },
    });
    return { visit, callList };
  });
  return {
    batch,
    progress,
    customer,
    vehicle,
    allocation,
    activeCre,
    inactiveCre,
    sequence: 2,
    ...records,
  };
}

async function createInvalidEvidenceBatch(kind, status = 'processing') {
  const { batch, progress } = await createBatch({
    status,
    outcome: 'created',
    rollbackSupported: status !== 'processing',
  });
  if (kind === 'contradictory-count') {
    await prisma.importRowProgress.update({
      where: { id: progress.id },
      data: { loggedChangeCount: 2 },
    });
  } else if (kind === 'orphaned-log') {
    await prisma.importChangeLog.create({
      data: {
        importBatchId: batch.id,
        rowProgressId: null,
        evidenceScope: 'row',
        sequence: 1,
        entityType: 'WorkshopVisit',
        entityId: nextId('orphan'),
        operation: 'CREATE',
        before: {},
        after: { id: nextId('orphan-snapshot') },
      },
    });
  } else if (kind === 'incomplete-snapshot') {
    const entityId = nextId('incomplete');
    await prisma.importChangeLog.create({
      data: {
        importBatchId: batch.id,
        rowProgressId: progress.id,
        evidenceScope: 'row',
        sequence: 1,
        entityType: 'WorkshopVisit',
        entityId,
        operation: 'CREATE',
        before: {},
        after: { id: entityId },
      },
    });
    await prisma.importRowProgress.update({
      where: { id: progress.id },
      data: { loggedChangeCount: 1 },
    });
  }
  return batch;
}

async function captureRollbackAtomicityState(fixture) {
  return prisma.$transaction(async (transaction) => ({
    customer: await transaction.customer.findUnique({ where: { id: fixture.customer.id } }),
    vehicle: await transaction.vehicle.findUnique({ where: { id: fixture.vehicle.id } }),
    visit: await transaction.workshopVisit.findUnique({ where: { id: fixture.visit.id } }),
    callList: fixture.callList
      ? await transaction.masterCallList.findUnique({ where: { id: fixture.callList.id } })
      : null,
    batch: await transaction.importBatch.findUnique({
      where: { id: fixture.batch.id },
      include: {
        rowProgress: { orderBy: { rowNumber: 'asc' } },
        changes: { orderBy: { sequence: 'asc' } },
        rowErrors: { orderBy: { rowNumber: 'asc' } },
      },
    }),
  }), { isolationLevel: 'RepeatableRead' });
}

afterEach(async () => {
  if (ownedCallListIds.size) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ownedCallListIds] } } });
  }
  if (ownedBatchIds.size) {
    const batchIds = [...ownedBatchIds];
    await prisma.auditLog.deleteMany({
      where: { entityType: 'ImportBatch', entityId: { in: batchIds } },
    });
    await prisma.importBatch.deleteMany({ where: { id: { in: batchIds } } });
    ownedBatchIds.clear();
  }
  if (ownedCallListIds.size) {
    await prisma.masterCallList.deleteMany({ where: { id: { in: [...ownedCallListIds] } } });
    ownedCallListIds.clear();
  }
  if (ownedVisitIds.size) {
    await prisma.workshopVisit.deleteMany({ where: { id: { in: [...ownedVisitIds] } } });
    ownedVisitIds.clear();
  }
  if (ownedVehicleIds.size) {
    await prisma.allocation.deleteMany({ where: { vehicleId: { in: [...ownedVehicleIds] } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: [...ownedVehicleIds] } } });
    ownedVehicleIds.clear();
  }
  if (ownedCustomerIds.size) {
    await prisma.customer.deleteMany({ where: { id: { in: [...ownedCustomerIds] } } });
    ownedCustomerIds.clear();
  }
  if (ownedUserIds.size) {
    await prisma.auditLog.deleteMany({ where: { userId: { in: [...ownedUserIds] } } });
    await prisma.user.deleteMany({ where: { id: { in: [...ownedUserIds] } } });
    ownedUserIds.clear();
  }
});

after(async () => {
  await prisma.$disconnect();
});

test('test URL validation accepts only the approved local database', () => {
  assert.equal(
    validateTestDatabaseUrl('postgresql://test:test@localhost:5432/lh_import_rollback_test'),
    'postgresql://test:test@localhost:5432/lh_import_rollback_test',
  );
  for (const value of [
    undefined,
    '',
    'postgresql://test:test@db.example.com:5432/lh_import_rollback_test',
    'postgresql://test:test@127.0.0.1:5432/another_database',
    'postgresql://test:test@192.168.1.10:5432/lh_import_rollback_test',
    'postgresql://test:test@localhost:5432/lh_import_rollback_test?host=db.example.com',
    'postgresql://test:placeholder@localhost:5432/lh_import_rollback_test#other-database',
  ]) {
    assert.throws(() => validateTestDatabaseUrl(value), /TEST_DATABASE_URL/);
  }
});

test('production import controller commits business mutations with row progress and change logs', async () => {
  const actor = await createImportActor();
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const repairOrderNo = nextId('controller-ro');
  const content = [
    'RO Number,VIN,Customer Name,Mobile,Make,Model,Total Labor Cost,Total Parts Cost,Visit Date',
    `${repairOrderNo},${vin},Controller Integration Customer,9000000001,Hyundai,Test,100,50,2026-01-15`,
  ].join('\n');
  let statusCode;
  let responseBody;

  await importRepairOrders({
    body: { fileName: 'controller-integration.csv', content },
    user: { id: actor.id, role: actor.role, ccmId: actor.ccmId },
    get: () => '',
  }, {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  });

  assert.equal(statusCode, 201);
  const batchId = responseBody.batch.id;
  ownedBatchIds.add(batchId);
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: {
      rowProgress: true,
      changes: { orderBy: { sequence: 'asc' } },
    },
  });
  assert.equal(batch.status, 'completed');
  assert.equal(batch.totalRows, 1);
  assert.equal(batch.processedRows, 1);
  assert.equal(batch.statsComplete, true);
  assert.equal(batch.rowProgress.length, 1);
  const [progress] = batch.rowProgress;
  assert.equal(progress.status, 'completed');
  assert.equal(progress.mutationState, 'complete');
  assert.equal(progress.outcome, 'created');

  const linkedChanges = batch.changes.filter(({ rowProgressId }) => rowProgressId === progress.id);
  assert.equal(progress.loggedChangeCount, linkedChanges.length);
  assert.ok(linkedChanges.every(({ evidenceScope, operation }) => (
    evidenceScope === 'row' && operation === 'CREATE'
  )));
  assert.deepEqual(new Set(linkedChanges.map(({ entityType }) => entityType)), new Set([
    'Customer',
    'Vehicle',
    'WorkshopVisit',
    'MasterCallList',
  ]));

  const [customer, vehicle, visit, callList] = await Promise.all([
    prisma.customer.findFirst({ where: { mobileNumber: '9000000001', ccmId: actor.ccmId } }),
    prisma.vehicle.findUnique({ where: { vin } }),
    prisma.workshopVisit.findUnique({ where: { repairOrderNo } }),
    prisma.masterCallList.findFirst({ where: { vin, ccmId: actor.ccmId } }),
  ]);
  assert.ok(customer);
  assert.ok(vehicle);
  assert.ok(visit);
  assert.ok(callList);
  ownedCustomerIds.add(customer.id);
  ownedVehicleIds.add(vehicle.id);
  ownedVisitIds.add(visit.id);
  ownedCallListIds.add(callList.id);
  assert.deepEqual(new Set(linkedChanges.map(({ entityId }) => entityId)), new Set([
    customer.id,
    vehicle.id,
    visit.id,
    callList.id,
  ]));
});

test('rollback transaction is atomic when a failure is injected after a real reverse delete', async () => {
  const fixture = await createBusinessFixture();
  const stateBeforeRollback = await captureRollbackAtomicityState(fixture);
  const database = wrappedDatabase(prisma, (delegateName, delegate) => {
    if (delegateName !== 'workshopVisit') return delegate;
    return new Proxy(delegate, {
      get(target, property) {
        if (property === 'delete') {
          return async (args) => {
            await target.delete(args);
            throw new Error('injected failure after PostgreSQL delete');
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });

  await assert.rejects(rollbackImportBatch(fixture.batch.id, null, database), /injected failure/);
  const stateAfterRollback = await captureRollbackAtomicityState(fixture);
  assert.deepEqual(stateAfterRollback, stateBeforeRollback);
  assert.ok(stateAfterRollback.customer);
  assert.ok(stateAfterRollback.vehicle);
  assert.ok(stateAfterRollback.visit);
  assert.equal(stateAfterRollback.batch.status, 'completed');
  assert.ok(stateAfterRollback.batch.rowProgress.every(({ status, mutationState }) => (
    status === 'completed' && mutationState === 'complete'
  )));
  assert.ok(stateAfterRollback.batch.changes.every(({ rollbackStatus }) => rollbackStatus === 'pending'));
});

test('CREATE then UPDATE rollback restores exact vehicle timestamps and reverses batch allocation evidence', async () => {
  const fixture = await createBusinessFixture({ includeCallList: true });
  await createActiveCre(fixture.customer.ccmId);

  await prisma.$transaction(async (transaction) => {
    const updatedVehicle = await updateVehicleWithEvidence(transaction, fixture, fixture.sequence + 1);
    fixture.vehicle = updatedVehicle;
    await applyBatchAllocation(transaction, fixture, fixture.sequence + 1);
  });
  const storedBatch = await prisma.importBatch.findUnique({
    where: { id: fixture.batch.id },
    include: { changes: true, rowProgress: true },
  });
  assert.equal(storedBatch.allocationEvidenceState, 'complete');
  assert.equal(storedBatch.allocationChangeCount, 1);
  assert.equal(importBatchMutationEvidenceIsComplete(storedBatch), true);

  const allocated = await prisma.masterCallList.findUnique({ where: { id: fixture.callList.id } });
  assert.ok(allocated.ownerUserId);
  const allocationChange = storedBatch.changes.find(({ evidenceScope }) => evidenceScope === 'batch');
  assert.equal(allocationChange.rowProgressId, null);
  assert.equal(allocationChange.after.updatedAt, allocated.updatedAt.toISOString());

  await rollbackImportBatch(fixture.batch.id, null);
  assert.equal(await prisma.customer.findUnique({ where: { id: fixture.customer.id } }), null);
  assert.equal(await prisma.vehicle.findUnique({ where: { id: fixture.vehicle.id } }), null);
  assert.equal(await prisma.masterCallList.findUnique({ where: { id: fixture.callList.id } }), null);
  assert.equal((await prisma.importBatch.findUnique({ where: { id: fixture.batch.id } })).status, 'rolled_back');
});

test('batch-scoped call-list and allocation updates roll back with exact timestamps', async () => {
  const fixture = await createAllocationFixture();
  await prisma.$transaction((transaction) => applyBatchAllocation(transaction, fixture, fixture.sequence));

  const committedBatch = await prisma.importBatch.findUnique({
    where: { id: fixture.batch.id },
    include: { changes: true, rowProgress: true },
  });
  assert.equal(committedBatch.allocationEvidenceState, 'complete');
  assert.equal(committedBatch.allocationChangeCount, 2);
  assert.equal(importBatchMutationEvidenceIsComplete(committedBatch), true);
  const batchAllocationLogs = committedBatch.changes.filter(({ evidenceScope }) => evidenceScope === 'batch');
  assert.deepEqual(new Set(batchAllocationLogs.map(({ entityType }) => entityType)), new Set(['MasterCallList', 'Allocation']));
  const updatedAllocation = await prisma.allocation.findUnique({ where: { id: fixture.allocation.id } });
  assert.equal(updatedAllocation.creId, fixture.activeCre.id);
  const allocationUpdate = batchAllocationLogs.find(({ entityType }) => entityType === 'Allocation');
  assert.equal(allocationUpdate.after.updatedAt, updatedAllocation.updatedAt.toISOString());

  await rollbackImportBatch(fixture.batch.id, null);
  const restoredAllocation = await prisma.allocation.findUnique({ where: { id: fixture.allocation.id } });
  assert.equal(restoredAllocation.creId, fixture.inactiveCre.id);
  assert.equal(restoredAllocation.updatedAt.toISOString(), fixture.allocation.updatedAt.toISOString());
  assert.equal(await prisma.masterCallList.findUnique({ where: { id: fixture.callList.id } }), null);
  assert.equal(await prisma.workshopVisit.findUnique({ where: { id: fixture.visit.id } }), null);
});

test('batch-scoped allocation logs and assignments roll back together on transaction failure', async () => {
  const fixture = await createAllocationFixture();

  await assert.rejects(prisma.$transaction(async (transaction) => {
    await applyBatchAllocation(transaction, fixture, fixture.sequence);
    throw new Error('injected allocation transaction failure');
  }), /injected allocation transaction failure/);

  const entry = await prisma.masterCallList.findUnique({ where: { id: fixture.callList.id } });
  const allocation = await prisma.allocation.findUnique({ where: { id: fixture.allocation.id } });
  const batch = await prisma.importBatch.findUnique({ where: { id: fixture.batch.id } });
  assert.equal(entry.ownerUserId, null);
  assert.equal(allocation.creId, fixture.inactiveCre.id);
  assert.equal(allocation.updatedAt.toISOString(), fixture.allocation.updatedAt.toISOString());
  assert.equal(batch.allocationEvidenceState, 'not_started');
  assert.equal(batch.allocationChangeCount, 0);
  assert.equal(await prisma.importChangeLog.count({
    where: { importBatchId: fixture.batch.id, evidenceScope: 'batch' },
  }), 0);
});

test('concurrent rollback attempts use separate PostgreSQL transactions and only one succeeds', async () => {
  const fixture = await createBusinessFixture();
  const backendPids = [];
  const bothTransactionsStarted = deferred();
  const gatedDatabase = startBarrierDatabase(prisma, 2, async (transaction) => {
    const result = await transaction.$queryRaw`SELECT pg_backend_pid() AS pid`;
    backendPids.push(Number(result[0].pid));
    if (backendPids.length === 2) bothTransactionsStarted.resolve();
    await bothTransactionsStarted.promise;
  });
  const results = await Promise.allSettled([
    rollbackImportBatch(fixture.batch.id, null, gatedDatabase),
    rollbackImportBatch(fixture.batch.id, null, gatedDatabase),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(new Set(backendPids).size, 2);
  assert.equal((await prisma.importBatch.findUnique({ where: { id: fixture.batch.id } })).status, 'rolled_back');
  assert.equal(await prisma.workshopVisit.findUnique({ where: { id: fixture.visit.id } }), null);
});

test('recovery cannot acquire an active import lock and succeeds after real PostgreSQL lock release', async () => {
  const { batch } = await createBatch({ status: 'processing', outcome: 'skipped', rollbackSupported: false });
  const release = await acquireImportProcessingLock(batch.id);
  assert.equal(await acquireImportProcessingLock(batch.id), null);
  await prisma.$transaction((transaction) => assertImportBatchProcessing(transaction, batch.id));

  await assert.rejects(recoverAbandonedImport(batch.id, null), ImportRecoveryConflict);
  await release();

  const result = await recoverAbandonedImport(batch.id, null);
  assert.equal(result.batch.status, 'failed');
  assert.equal(result.batch.rollbackSupported, true);
});

test('lost advisory-lock connection cannot bypass the worker batch-status fence', async () => {
  const { batch } = await createBatch({ status: 'processing', outcome: 'skipped', rollbackSupported: false });
  let backendPid;
  const lockConnectionError = deferred();
  const release = await acquireImportProcessingLock(batch.id, (options) => {
    const client = new Client(options);
    client.on('error', (error) => lockConnectionError.resolve(error));
    const query = client.query.bind(client);
    client.query = async (...args) => {
      const result = await query(...args);
      if (args[0] === 'BEGIN') {
        const pidResult = await query('SELECT pg_backend_pid() AS pid');
        backendPid = Number(pidResult.rows[0].pid);
      }
      return result;
    };
    return client;
  });

  assert.ok(Number.isInteger(backendPid));
  const terminated = await prisma.$queryRaw`SELECT pg_terminate_backend(${backendPid}, 5000) AS terminated`;
  assert.equal(terminated[0].terminated, true);
  const connectionError = await lockConnectionError.promise;
  assert.equal(connectionError.code, '57P01');
  const probeRelease = await acquireImportProcessingLock(batch.id);
  assert.equal(typeof probeRelease, 'function');
  await probeRelease();
  const observer = new Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  try {
    const readPersistedState = async (customerId) => {
      const [batchResult, rowResult, changeResult, customerResult] = await Promise.all([
        observer.query(
          'SELECT "status", "rollbackSupported", "processedRows" FROM "import_batches" WHERE "id" = $1',
          [batch.id],
        ),
        observer.query(
          'SELECT "status", "outcome", "mutationState", "loggedChangeCount" FROM "import_row_progress" WHERE "importBatchId" = $1',
          [batch.id],
        ),
        observer.query(
          'SELECT COUNT(*)::int AS count FROM "import_change_logs" WHERE "importBatchId" = $1',
          [batch.id],
        ),
        observer.query(
          'SELECT COUNT(*)::int AS count FROM "customers" WHERE "id" = $1',
          [customerId],
        ),
      ]);
      return {
        batch: batchResult.rows[0],
        rowProgress: rowResult.rows,
        changeCount: changeResult.rows[0].count,
        customerCount: customerResult.rows[0].count,
      };
    };

    const recovered = await recoverAbandonedImport(batch.id, null);
    assert.equal(recovered.batch.status, 'failed');
    const fencedCustomerId = nextId('fenced-customer');
    ownedCustomerIds.add(fencedCustomerId);
    const recoveredState = await readPersistedState(fencedCustomerId);
    assert.deepEqual(recoveredState.batch, {
      status: 'failed',
      rollbackSupported: true,
      processedRows: 1,
    });
    assert.deepEqual(recoveredState.rowProgress, [{
      status: 'completed',
      outcome: 'skipped',
      mutationState: 'complete',
      loggedChangeCount: 0,
    }]);
    assert.equal(recoveredState.changeCount, 0);
    assert.equal(recoveredState.customerCount, 0);

    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await assertImportBatchProcessing(transaction, batch.id);
        await transaction.customer.create({
          data: {
            id: fencedCustomerId,
            customerCode: nextId('fenced-code'),
            fullName: 'Must not be written after recovery',
          },
        });
      }),
      /batch is no longer active/,
    );
    const finalState = await readPersistedState(fencedCustomerId);
    assert.deepEqual(finalState, recoveredState);
  } finally {
    await observer.end();
  }
  await assert.rejects(release, (error) => error.code === '57P01');
});

test('a concurrent manual edit during rollback is not overwritten', async () => {
  const fixture = await createBusinessFixture();
  await prisma.$transaction(async (transaction) => {
    await updateVehicleWithEvidence(transaction, fixture, fixture.sequence + 1);
  });

  const readReached = deferred();
  const resumeRollback = deferred();
  const coordinatedDatabase = wrappedDatabase(prisma, (delegateName, delegate) => {
    if (delegateName !== 'vehicle') return delegate;
    return new Proxy(delegate, {
      get(target, property) {
        if (property === 'findUnique') {
          return async (args) => {
            const record = await target.findUnique(args);
            readReached.resolve();
            await resumeRollback.promise;
            return record;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const rollbackAttempt = rollbackImportBatch(fixture.batch.id, null, coordinatedDatabase);
  await readReached.promise;
  const manualSaleDate = new Date('2026-03-20T00:00:00.000Z');
  await prisma.vehicle.update({
    where: { id: fixture.vehicle.id },
    data: { saleDate: manualSaleDate },
  });
  resumeRollback.resolve();

  await assert.rejects(rollbackAttempt);
  const vehicleAfterConflict = await prisma.vehicle.findUnique({ where: { id: fixture.vehicle.id } });
  assert.equal(vehicleAfterConflict.saleDate.toISOString(), manualSaleDate.toISOString());
  assert.equal((await prisma.importBatch.findUnique({ where: { id: fixture.batch.id } })).status, 'completed');
});

test('real foreign keys and rollback dependency checks preserve a referenced vehicle', async () => {
  const fixture = await createBusinessFixture();
  const manualCallId = nextId('manual-call');
  ownedCallListIds.add(manualCallId);
  const manualCall = await prisma.masterCallList.create({
    data: {
      id: manualCallId,
      customerName: 'Later customer',
      mobileNumber: '9111111111',
      vin: fixture.vehicle.vin,
      ccmId: fixture.customer.ccmId,
    },
  });

  await assert.rejects(
    rollbackImportBatch(fixture.batch.id, null),
    ImportRollbackConflict,
  );
  assert.ok(await prisma.vehicle.findUnique({ where: { id: fixture.vehicle.id } }));
  const preservedCall = await prisma.masterCallList.findUnique({ where: { id: manualCall.id } });
  assert.equal(preservedCall.vin, manualCall.vin);
  assert.equal(preservedCall.customerName, manualCall.customerName);
  await assert.rejects(
    prisma.vehicle.delete({ where: { id: fixture.vehicle.id } }),
    (error) => error?.code === 'P2003',
  );
});

test('recovery and rollback reject missing, orphaned, contradictory, and incomplete mutation evidence', async () => {
  for (const kind of ['missing-log', 'orphaned-log', 'contradictory-count', 'incomplete-snapshot']) {
    const recoverBatch = await createInvalidEvidenceBatch(kind, 'processing');
    if (kind === 'incomplete-snapshot') {
      const [change] = await prisma.importChangeLog.findMany({
        where: { importBatchId: recoverBatch.id },
      });
      assert.equal(change.after.id, change.entityId);
      assert.deepEqual(Object.keys(change.after), ['id']);
    }
    const recovery = await recoverAbandonedImport(recoverBatch.id, null);
    assert.equal(recovery.status, 'recovery_blocked', `${kind} recovery should be blocked`);
    assert.equal(recovery.batch.rollbackSupported, false);
    if (kind === 'incomplete-snapshot') {
      assert.match(recovery.reason, /change-log snapshots are incomplete or contradictory/);
    }

    const rollbackBatch = await createInvalidEvidenceBatch(kind, 'failed');
    await assert.rejects(
      rollbackImportBatch(rollbackBatch.id, null),
      (error) => {
        assert.ok(error instanceof ImportRollbackConflict);
        if (kind === 'incomplete-snapshot') {
          assert.match(error.message, /complete row progress and change snapshots/);
        }
        return true;
      },
      `${kind} rollback should be blocked`,
    );
    if (kind === 'incomplete-snapshot') {
      const [change] = await prisma.importChangeLog.findMany({
        where: { importBatchId: rollbackBatch.id },
      });
      assert.equal(change.after.id, change.entityId);
      assert.deepEqual(Object.keys(change.after), ['id']);
    }
    assert.equal((await prisma.importBatch.findUnique({ where: { id: rollbackBatch.id } })).status, 'failed');
  }
});
