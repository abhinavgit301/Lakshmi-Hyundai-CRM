import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import test, { after, before } from 'node:test';

const databaseUrl = process.env.PHASE3_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('Phase 3 PostgreSQL integration requires the approved local database URL', { skip: true }, () => {});
} else {
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)
    || !['localhost', '127.0.0.1', '::1'].includes(parsedDatabaseUrl.hostname.toLowerCase())
    || parsedDatabaseUrl.port !== '5432'
    || decodeURIComponent(parsedDatabaseUrl.pathname.slice(1)) !== 'lakshmi_hyundai_phase3_test'
    || parsedDatabaseUrl.search !== ''
    || parsedDatabaseUrl.hash !== '') {
    throw new Error('PHASE3_TEST_DATABASE_URL must target localhost:5432/lakshmi_hyundai_phase3_test.');
  }

  process.env.DATABASE_URL = databaseUrl;

const [{ prisma }, { Client: PgClient }, allocationController, userController, recordsController, masterCallList, rollbackService, deletionService] = await Promise.all([
  import('../../src/config/prisma.js'),
  import('pg'),
  import('../../src/controllers/allocationController.js'),
  import('../../src/controllers/userController.js'),
  import('../../src/controllers/recordsController.js'),
  import('../../src/utils/masterCallList.js'),
  import('../../src/services/importRollbackService.js'),
  import('../../src/services/permanentImportDeletionService.js'),
]);
const { findOrCreatePhysicalVehicle } = await import('../../src/utils/physicalVehicle.js');
const { importRepairOrders } = await import('../../src/controllers/importController.js');
const { importMonthlyCustomerData } = await import('../../src/controllers/monthlyCustomerDataController.js');
const { importSnapshot, recordImportChange } = await import('../../src/utils/importChangeLog.js');
const { operationalReadScope } = await import('../../src/controllers/recordsController.js');
const physicalVehicleMigration = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20261105000000_shared_physical_vehicle_service_history/migration.sql', import.meta.url)), 'utf8');
const physicalVehiclePreflight = physicalVehicleMigration.match(/DO \$\$[\s\S]*?\nEND \$\$;/)?.[0];
if (!physicalVehiclePreflight) throw new Error('Could not load physical-vehicle migration preflight SQL.');

const suffix = randomUUID().replaceAll('-', '');
const id = (label) => `p3-${label}-${suffix}`;
let verificationClient;

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function createCustomer(label, ccmId, mobileNumber = null) {
  return prisma.customer.create({
    data: {
      id: id(label),
      customerCode: id(`${label}-code`),
      fullName: `Phase 3 ${label}`,
      mobileNumber,
      ccmId,
    },
  });
}

async function createVehicle(label, customer, ccmId) {
  const physicalVehicle = await prisma.$transaction((transaction) => findOrCreatePhysicalVehicle(transaction, id(`${label}-vin`)));
  return prisma.vehicle.create({
    data: {
      id: id(label),
      vin: id(`${label}-vin`),
      physicalVehicleId: physicalVehicle.id,
      customerId: customer.id,
      ccmId,
      model: 'Integration fixture',
    },
  });
}

async function createUser(label, role, ccmId = null, status = 'active', dealerCode = null) {
  return prisma.user.create({
    data: {
      id: id(label),
      username: `${label}-${suffix.slice(0, 8)}`.toLowerCase(),
      name: `Phase 3 ${label}`,
      password: 'integration-fixture-not-a-login',
      role,
      ccmId,
      dealerCode,
      status,
    },
  });
}

async function createWorkshopVisit(label, customer, vehicle, ccmId, repairOrderNo, visitDate) {
  const { normalizeRepairOrderNo } = await import('../../src/utils/repairOrderIdentity.js');
  return prisma.workshopVisit.create({
    data: {
      id: id(label),
      repairOrderNo,
      normalizedRepairOrderNo: normalizeRepairOrderNo(repairOrderNo),
      customerId: customer.id,
      vehicleId: vehicle.id,
      physicalVehicleId: vehicle.physicalVehicleId,
      ccmId,
      visitDate,
    },
  });
}

async function importCsv(content, admin, ccmId, idempotencyKey = null) {
  const res = responseRecorder();
  await importRepairOrders({
    body: { fileName: 'phase3-shared-history.csv', content, ccmId },
    query: {},
    params: {},
    user: { id: admin.id, role: admin.role, ccmId: admin.ccmId },
    get: (name) => name === 'Idempotency-Key' ? idempotencyKey || '' : '',
  }, res);
  return res;
}

async function importMonthlyCsv(content, admin, ccmId, year, month) {
  const res = responseRecorder();
  await importMonthlyCustomerData({
    body: { fileName: 'phase3-monthly-customers.csv', content },
    params: { ccmId },
    query: { year: String(year), month: String(month) },
    user: { id: admin.id, role: admin.role, ccmId: admin.ccmId },
  }, res);
  return res;
}

async function runImportsBehindAllocationLock(ccmId, importRequests) {
  const blocker = new PgClient({ connectionString: databaseUrl });
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`customer-allocation:${ccmId}`],
  );
  const pendingImports = Promise.all(importRequests.map((startImport) => startImport()));
  try {
    await waitForAdvisoryLockWaiters(importRequests.length);
  } catch (error) {
    await blocker.query('ROLLBACK');
    await pendingImports.catch(() => {});
    await blocker.end();
    throw error;
  }
  await blocker.query('COMMIT');
  const results = await pendingImports;
  await blocker.end();
  return results;
}

function csvRow(repairOrder, vin, registrationNumber, name = 'Phase 3 import customer') {
  return [
    'RO Number,VIN,Customer Name,Mobile,Make,Model,Reg No,Visit Date',
    `${repairOrder},${vin},${name},5551000,Hyundai,Test,${registrationNumber},2026-01-15`,
  ].join('\n');
}

async function createVisitImportEvidence(label, admin, ccmId, visit) {
  const batch = await prisma.importBatch.create({
    data: {
      id: id(`${label}-batch`),
      fileName: `${label}.csv`,
      importedByUserId: admin.id,
      ccmId,
      totalRows: 1,
      processedRows: 1,
      createdRows: 1,
      affectedRepairOrders: 1,
      status: 'completed',
      rollbackSupported: true,
      statsComplete: true,
      affectedCountsComplete: true,
    },
  });
  const progress = await prisma.importRowProgress.create({
    data: {
      id: id(`${label}-progress`),
      importBatchId: batch.id,
      rowNumber: 1,
      status: 'completed',
      outcome: 'created',
      mutationState: 'complete',
      loggedChangeCount: 1,
    },
  });
  await prisma.importChangeLog.create({
    data: {
      id: id(`${label}-change`),
      importBatchId: batch.id,
      rowProgressId: progress.id,
      sequence: 1,
      entityType: 'WorkshopVisit',
      entityId: visit.id,
      ccmId,
      operation: 'CREATE',
      before: {},
      after: JSON.parse(JSON.stringify(visit)),
    },
  });
  return batch;
}

async function applyTrackedImportUpdate(importBatchId, entityType, entityId, ccmId, fields) {
  const delegateByEntityType = { Customer: 'customer', Vehicle: 'vehicle' };
  const delegate = delegateByEntityType[entityType];
  if (!delegate) throw new Error(`Unsupported integration update entity: ${entityType}`);
  return prisma.$transaction(async (transaction) => {
    const record = await transaction[delegate].findUniqueOrThrow({ where: { id: entityId } });
    const progress = await transaction.importRowProgress.findFirstOrThrow({ where: { importBatchId } });
    const lastChange = await transaction.importChangeLog.findFirst({
      where: { importBatchId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const before = Object.fromEntries([...Object.keys(fields), 'updatedAt'].map((field) => [field, record[field]]));
    const updatedAt = new Date(record.updatedAt.getTime() + 1000);
    const updated = await transaction[delegate].update({
      where: { id: entityId },
      data: { ...fields, updatedAt },
    });
    const after = Object.fromEntries([...Object.keys(fields), 'updatedAt'].map((field) => [field, updated[field]]));
    await recordImportChange(transaction, {
      importBatchId,
      rowProgressId: progress.id,
      sequence: (lastChange?.sequence || 0) + 1,
      entityType,
      entityId,
      ccmId,
      operation: 'UPDATE',
      before: importSnapshot(before),
      after: importSnapshot(after),
    });
    await transaction.importRowProgress.update({
      where: { id: progress.id },
      data: { loggedChangeCount: { increment: 1 } },
    });
    return updated;
  });
}

async function runController(controller, req) {
  const res = responseRecorder();
  await controller(req, res);
  return res;
}

async function transferCre(cre, actor, ccmId) {
  return runController(userController.updateManagedUser, {
    params: { id: cre.id },
    user: actor,
    body: { ccmId },
  });
}

async function createAllocation(vehicle, cre, actor, serviceType) {
  return runController(allocationController.createAllocation, {
    user: actor,
    body: { vehicleId: vehicle.id, creId: cre.id, serviceType },
  });
}

async function waitForAdvisoryLockWaiters(expectedCount) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await verificationClient.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%pg_advisory_xact_lock%'`,
    );
    if (result.rows[0].count >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${expectedCount} PostgreSQL advisory-lock waiters.`);
}

before(async () => {
  verificationClient = new PgClient({ connectionString: databaseUrl });
  await verificationClient.connect();
  const identity = await verificationClient.query(
    'SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port',
  );
  assert.equal(identity.rows[0].database, 'lakshmi_hyundai_phase3_test');
  assert.ok(['127.0.0.1', '::1'].includes(identity.rows[0].address.replace(/\/\d+$/, '')));
  assert.equal(identity.rows[0].port, 5432);
});

after(async () => {
  await prisma.$disconnect();
  await verificationClient?.end();
});

test('repair-order identity is unique within a CCM but permits the same normalized RO across CCMs', async () => {
  const teamA = id('ro-team-a');
  const teamB = id('ro-team-b');
  const repairOrder = id('ro-number');
  const customer = await createCustomer('ro-customer', teamA);
  const vehicle = await createVehicle('ro-vehicle', customer, teamA);
  await createWorkshopVisit('ro-a', customer, vehicle, teamA, ` ${repairOrder} `, new Date('2026-01-01T00:00:00Z'));
  await createWorkshopVisit('ro-b', customer, vehicle, teamB, repairOrder, new Date('2026-01-02T00:00:00Z'));
  await assert.rejects(
    createWorkshopVisit('ro-duplicate', customer, vehicle, teamA, repairOrder, new Date()),
    (error) => error?.code === 'P2002',
  );
});

test('physical vehicle migration preflight rejects missing ownership and ambiguous scoped VIN data', async () => {
  await verificationClient.query('BEGIN');
  try {
    await verificationClient.query('CREATE TEMP TABLE vehicles (id TEXT, vin TEXT, "ccmId" TEXT, "registrationNumber" TEXT, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP)');
    await verificationClient.query('CREATE TEMP TABLE workshop_visits (id TEXT, "vehicleId" TEXT)');
    await verificationClient.query('CREATE TEMP TABLE free_service_milestones (id TEXT, "vehicleId" TEXT)');
    await verificationClient.query(
      'INSERT INTO vehicles (id, vin, "ccmId") VALUES ($1, $2, NULL)',
      [id('preflight-null-owner'), id('preflight-vin')],
    );
    await verificationClient.query('SAVEPOINT missing_owner_preflight');
    await assert.rejects(verificationClient.query(physicalVehiclePreflight), /unresolved CCM/i);
    await verificationClient.query('ROLLBACK TO SAVEPOINT missing_owner_preflight');
    await verificationClient.query('DELETE FROM vehicles');

    await verificationClient.query(
      'INSERT INTO vehicles (id, vin, "ccmId") VALUES ($1, $2, $3), ($4, $5, $3)',
      [id('preflight-duplicate-a'), '1HG12345678901234', id('preflight-team'), id('preflight-duplicate-b'), '1hg-12345678901234'],
    );
    await verificationClient.query('SAVEPOINT duplicate_scope_preflight');
    await assert.rejects(verificationClient.query(physicalVehiclePreflight), /vehicle scopes are duplicated/i);
    await verificationClient.query('ROLLBACK TO SAVEPOINT duplicate_scope_preflight');
  } finally {
    await verificationClient.query('ROLLBACK');
  }
});

test('repair-order imports create CCM-specific vehicle rows and share service history across every linked CCM', async () => {
  const ccmAId = id('shared-history-ccm-a');
  const ccmBId = id('shared-history-ccm-b');
  const ccmCId = id('shared-history-ccm-c');
  const admin = await createUser('shared-history-admin', 'ADMIN');
  const ccmA = await createUser('shared-history-ccm-a-user', 'CCM', ccmAId, 'active', 'A001');
  const ccmB = await createUser('shared-history-ccm-b-user', 'CCM', ccmBId, 'active', 'B002');
  const ccmC = await createUser('shared-history-ccm-c-user', 'CCM', ccmCId, 'active', 'C003');
  const vin = `1HG${suffix.slice(0, 14).toUpperCase()}`;
  const registration = id('shared-history-registration');
  const crossTeamRepairOrder = id('shared-ro-shared').toUpperCase();

  const importA = await importCsv(csvRow(crossTeamRepairOrder, vin, registration), admin, ccmAId);
  assert.equal(importA.statusCode, 201, JSON.stringify(importA.body));
  assert.equal(importA.body.batch.createdRows, 1, JSON.stringify(importA.body));
  const firstVehicleA = await prisma.vehicle.findFirstOrThrow({ where: { vin, ccmId: ccmAId } });
  const physical = await prisma.physicalVehicle.findUniqueOrThrow({ where: { vin } });
  assert.equal(firstVehicleA.physicalVehicleId, physical.id);

  const importB = await importCsv(csvRow(crossTeamRepairOrder, vin, registration), admin, ccmBId);
  assert.equal(importB.statusCode, 201);
  const vehicleB = await prisma.vehicle.findFirstOrThrow({ where: { vin, ccmId: ccmBId } });
  assert.notEqual(vehicleB.id, firstVehicleA.id);
  assert.equal(vehicleB.customerId === firstVehicleA.customerId, false);
  assert.equal(vehicleB.physicalVehicleId, firstVehicleA.physicalVehicleId);
  assert.equal(await prisma.physicalVehicle.count({ where: { vin } }), 1);

  const ccmBList = await runController(recordsController.getCallList, { user: ccmB, query: {} });
  const bRecord = ccmBList.body.records.find(({ vin: rowVin }) => rowVin === vin);
  assert.ok(bRecord);
  assert.equal(bRecord.workshopVisits.length, 2);
  const ccmAList = await runController(recordsController.getCallList, { user: ccmA, query: {} });
  const aRecord = ccmAList.body.records.find(({ vin: rowVin }) => rowVin === vin);
  const expectedDealerCodes = new Map([
    [`${ccmAId}:${crossTeamRepairOrder}`, 'A001'],
    [`${ccmBId}:${crossTeamRepairOrder}`, 'B002'],
  ]);
  for (const record of [aRecord, bRecord]) {
    assert.ok(record);
    assert.deepEqual(
      new Map(record.workshopVisits.map(({ ccmId: originCcmId, repairOrderNo, dealerCode }) => [
        `${originCcmId}:${repairOrderNo}`,
        dealerCode,
      ])),
      expectedDealerCodes,
    );
  }
  const [ccmACustomers, ccmBCustomers] = await Promise.all([ccmA, ccmB].map(async (user) => {
    const response = await runController(recordsController.getCustomers, { user });
    return response.body.customers;
  }));
  for (const customers of [ccmACustomers, ccmBCustomers]) {
    const history = customers.flatMap(({ visits }) => visits)
      .filter(({ repairOrderNo }) => repairOrderNo === crossTeamRepairOrder);
    assert.deepEqual(
      new Map(history.map(({ ccmId: originCcmId, repairOrderNo, dealerCode }) => [
        `${originCcmId}:${repairOrderNo}`,
        dealerCode,
      ])),
      expectedDealerCodes,
    );
  }

  const importBNewService = await importCsv(csvRow(id('shared-ro-c'), vin, registration), admin, ccmBId);
  const importANewService = await importCsv(csvRow(id('shared-ro-d'), vin, registration), admin, ccmAId);
  assert.equal(importBNewService.statusCode, 201);
  assert.equal(importANewService.statusCode, 201);

  const ccmCImport = await importCsv(csvRow(id('shared-ro-e'), vin, registration), admin, ccmCId);
  assert.equal(ccmCImport.statusCode, 201);
  const ccmCVehicle = await prisma.vehicle.findFirstOrThrow({ where: { vin, ccmId: ccmCId } });
  assert.equal(ccmCVehicle.physicalVehicleId, physical.id);
  const allVisits = await prisma.workshopVisit.findMany({
    where: { physicalVehicleId: physical.id },
    orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(allVisits.length, 5);
  assert.equal(new Set(allVisits.map(({ ccmId: originCcmId }) => originCcmId)).size, 3);

  const duplicateWithinTeam = await importCsv(csvRow(crossTeamRepairOrder, vin, registration), admin, ccmBId);
  assert.equal(duplicateWithinTeam.statusCode, 201);
  assert.equal(duplicateWithinTeam.body.batch.skippedRows, 1);
  assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id, normalizedRepairOrderNo: crossTeamRepairOrder, ccmId: ccmBId } }), 1);

  const retryKey = id('shared-history-idempotency-key');
  const retryContent = csvRow(id('shared-ro-retry'), vin, registration);
  const firstRetryRequest = await importCsv(retryContent, admin, ccmBId, retryKey);
  const secondRetryRequest = await importCsv(retryContent, admin, ccmBId, retryKey);
  assert.equal(firstRetryRequest.statusCode, 201);
  assert.equal(secondRetryRequest.statusCode, 200);
  assert.equal(
    await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id, repairOrderNo: id('shared-ro-retry'), ccmId: ccmBId } }),
    1,
  );
  assert.equal(await prisma.vehicle.count({ where: { physicalVehicleId: physical.id, ccmId: ccmBId } }), 1);

  const [callLog, followUp, allocationA] = await prisma.$transaction(async (transaction) => {
    const ccmACustomer = await transaction.customer.findUniqueOrThrow({ where: { id: firstVehicleA.customerId } });
    const log = await transaction.callLog.create({
      data: {
        customerId: ccmACustomer.id,
        vehicleId: firstVehicleA.id,
        ccmId: ccmAId,
        createdById: admin.id,
        callSource: 'SERVICE',
        outcome: 'CONTACTED',
        notes: 'CCM A private operation',
      },
    });
    const follow = await transaction.followUp.create({
      data: {
        customerId: ccmACustomer.id,
        vehicleId: firstVehicleA.id,
        ccmId: ccmAId,
        creId: null,
        source: 'SERVICE',
        followUpAt: new Date(),
        category: 'integration',
        status: 'pending',
      },
    });
    const allocation = await transaction.allocation.create({
      data: { vehicleId: firstVehicleA.id, ccmId: ccmAId, serviceType: 'private', status: 'assigned' },
    });
    return [log, follow, allocation];
  });
  const ccmBScope = operationalReadScope(ccmB);
  assert.equal(await prisma.callLog.count({ where: ccmBScope.call }), 0);
  assert.equal(await prisma.followUp.count({ where: ccmBScope.followUp }), 0);
  assert.equal(await prisma.allocation.count({ where: ccmBScope.allocation }), 0);
  assert.equal(await prisma.callLog.count({ where: { id: callLog.id } }), 1);
  assert.equal(await prisma.followUp.count({ where: { id: followUp.id } }), 1);
  assert.equal(await prisma.allocation.count({ where: { id: allocationA.id } }), 1);
});

test('concurrent imports for one CCM/VIN retain one physical identity and one scoped vehicle record', async () => {
  const ccmId = id('concurrent-import-team');
  const admin = await createUser('concurrent-import-admin', 'ADMIN');
  await createUser('concurrent-import-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registration = id('concurrent-import-registration');
  const results = await Promise.all([
    importCsv(csvRow(id('concurrent-import-ro-a'), vin, registration, 'Concurrent A'), admin, ccmId),
    importCsv(csvRow(id('concurrent-import-ro-b'), vin, registration, 'Concurrent B'), admin, ccmId),
  ]);
  assert.ok(results.every(({ statusCode }) => statusCode === 201), JSON.stringify(results.map(({ statusCode, body }) => ({ statusCode, body }))));
  const [physicalCount, localCount, visitCount] = await Promise.all([
    prisma.physicalVehicle.count({ where: { vin } }),
    prisma.vehicle.count({ where: { vin, ccmId } }),
    prisma.workshopVisit.count({ where: { ccmId, physicalVehicle: { is: { vin } } } }),
  ]);
  assert.equal(physicalCount, 1);
  assert.equal(localCount, 1);
  assert.equal(visitCount, 2);
});

test('concurrent same-CCM imports of one normalized RO and VIN are idempotent', async () => {
  const ccmId = id('concurrent-duplicate-team');
  const admin = await createUser('concurrent-duplicate-admin', 'ADMIN');
  await createUser('concurrent-duplicate-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const repairOrder = ` ${id('concurrent-duplicate-ro').toLowerCase()} `;
  const registration = id('concurrent-duplicate-registration');
  const results = await runImportsBehindAllocationLock(ccmId, [
    () => importCsv(csvRow(repairOrder, vin, registration), admin, ccmId),
    () => importCsv(csvRow(repairOrder, vin, registration), admin, ccmId),
  ]);

  assert.ok(results.every(({ statusCode }) => statusCode === 201), JSON.stringify(results.map(({ statusCode, body }) => ({ statusCode, body }))));
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.createdRows, 0), 1);
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.skippedRows, 0), 1);
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.rejectedRows, 0), 0);
  assert.equal(
    await prisma.workshopVisit.count({
      where: { ccmId, normalizedRepairOrderNo: repairOrder.trim().replace(/\s+/g, ' ').toUpperCase() },
    }),
    1,
  );
});

test('concurrent same-CCM RO import for a different VIN remains a conflict', async () => {
  const ccmId = id('concurrent-conflict-team');
  const admin = await createUser('concurrent-conflict-admin', 'ADMIN');
  await createUser('concurrent-conflict-ccm', 'CCM', ccmId);
  const repairOrder = id('concurrent-conflict-ro');
  const vinA = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const vinB = `2HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const results = await runImportsBehindAllocationLock(ccmId, [
    () => importCsv(csvRow(repairOrder, vinA, id('concurrent-conflict-reg-a')), admin, ccmId),
    () => importCsv(csvRow(repairOrder, vinB, id('concurrent-conflict-reg-b')), admin, ccmId),
  ]);

  assert.ok(results.every(({ statusCode }) => statusCode === 201), JSON.stringify(results.map(({ statusCode, body }) => ({ statusCode, body }))));
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.createdRows, 0), 1);
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.rejectedRows, 0), 1);
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.skippedRows, 0), 0);
  const rejected = results.flatMap(({ body }) => body.errors).find(({ status }) => status === 'rejected');
  assert.match(rejected.errorMessage, /already assigned to a different VIN/i);
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, normalizedRepairOrderNo: repairOrder.toUpperCase() } }), 1);
});

test('concurrent unrelated registration uniqueness conflict is not treated as an idempotent RO duplicate', async () => {
  const ccmId = id('concurrent-registration-team');
  const admin = await createUser('concurrent-registration-admin', 'ADMIN');
  await createUser('concurrent-registration-ccm', 'CCM', ccmId);
  const registration = id('concurrent-registration-shared');
  const results = await runImportsBehindAllocationLock(ccmId, [
    () => importCsv(csvRow(id('concurrent-registration-ro-a'), `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`, registration), admin, ccmId),
    () => importCsv(csvRow(id('concurrent-registration-ro-b'), `2HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`, registration), admin, ccmId),
  ]);

  assert.ok(results.every(({ statusCode }) => statusCode === 201), JSON.stringify(results.map(({ statusCode, body }) => ({ statusCode, body }))));
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.createdRows, 0), 1);
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.rejectedRows, 0), 1);
  assert.equal(results.reduce((sum, { body }) => sum + body.batch.skippedRows, 0), 0);
  assert.equal(await prisma.vehicle.count({ where: { ccmId, registrationNumber: registration.toUpperCase() } }), 1);
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId } }), 1);
});

test('repair-order import reuses a CCM vehicle by canonical physical VIN identity', async () => {
  const ccmId = id('legacy-vin-team');
  const admin = await createUser('legacy-vin-admin', 'ADMIN');
  await createUser('legacy-vin-ccm', 'CCM', ccmId);
  const cre = await createUser('legacy-vin-cre', 'CRE', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const legacyVin = `${vin.slice(0, 3)}-${vin.slice(3)}`;
  const registration = id('legacy-vin-registration');
  const physical = await prisma.$transaction((transaction) => findOrCreatePhysicalVehicle(transaction, vin));
  const customer = await createCustomer('legacy-vin-customer', ccmId, '5551011');
  const vehicle = await prisma.vehicle.create({
    data: {
      id: id('legacy-vin-vehicle'),
      vin: legacyVin,
      physicalVehicleId: physical.id,
      registrationNumber: registration,
      customerId: customer.id,
      ccmId,
    },
  });
  const [masterEntry, allocation, callLog] = await prisma.$transaction(async (transaction) => {
    const master = await transaction.masterCallList.create({
      data: {
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber,
        vin,
        vehicleId: vehicle.id,
        registrationNumber: registration,
        ccmId,
        ownerUserId: cre.id,
        status: 'assigned',
      },
    });
    const assigned = await transaction.allocation.create({
      data: { vehicleId: vehicle.id, creId: cre.id, ccmId, serviceType: 'legacy-vin-service', status: 'assigned' },
    });
    const log = await transaction.callLog.create({
      data: {
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
        createdById: admin.id,
        callSource: 'SERVICE',
        outcome: 'CONTACTED',
        notes: 'Preserved legacy-VIN call history',
      },
    });
    return [master, assigned, log];
  });

  const result = await importCsv(csvRow(id('legacy-vin-ro'), vin, registration), admin, ccmId);
  assert.equal(result.statusCode, 201, JSON.stringify(result.body));
  const [storedVehicles, storedVehicle, storedMaster, storedAllocation, storedCallLog] = await Promise.all([
    prisma.vehicle.findMany({ where: { physicalVehicleId: physical.id, ccmId } }),
    prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } }),
    prisma.masterCallList.findUniqueOrThrow({ where: { id: masterEntry.id } }),
    prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } }),
    prisma.callLog.findUniqueOrThrow({ where: { id: callLog.id } }),
  ]);
  assert.equal(storedVehicles.length, 1);
  assert.equal(storedVehicle.vin, legacyVin);
  assert.equal(storedVehicle.customerId, customer.id);
  assert.equal(storedMaster.vehicleId, vehicle.id);
  assert.equal(storedMaster.ownerUserId, cre.id);
  assert.equal(storedMaster.status, 'assigned');
  assert.equal(storedAllocation.vehicleId, vehicle.id);
  assert.equal(storedCallLog.vehicleId, vehicle.id);
  assert.equal(await prisma.customer.count({ where: { id: customer.id } }), 1);
});

test('monthly customer import reuses a CCM vehicle by canonical physical VIN identity', async () => {
  const ccmId = id('monthly-legacy-vin-team');
  const admin = await createUser('monthly-legacy-vin-admin', 'ADMIN');
  await createUser('monthly-legacy-vin-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const legacyVin = `${vin.slice(0, 3)}-${vin.slice(3)}`;
  const registration = id('monthly-legacy-vin-registration');
  const physical = await prisma.$transaction((transaction) => findOrCreatePhysicalVehicle(transaction, vin));
  const customer = await createCustomer('monthly-legacy-vin-customer', ccmId, '5551012');
  const vehicle = await prisma.vehicle.create({
    data: {
      id: id('monthly-legacy-vin-vehicle'),
      vin: legacyVin,
      physicalVehicleId: physical.id,
      registrationNumber: registration,
      customerId: customer.id,
      ccmId,
    },
  });
  const allocation = await prisma.allocation.create({
    data: { vehicleId: vehicle.id, ccmId, serviceType: 'monthly-legacy-vin-service', status: 'assigned' },
  });

  const result = await importMonthlyCsv([
    'Customer Name,Mobile,VIN,Registration Number,Make,Model',
    `Monthly Customer,5551012,${vin},${registration},Hyundai,Test`,
  ].join('\n'), admin, ccmId, 2026, 9);

  assert.equal(result.statusCode, 201, JSON.stringify(result.body));
  assert.equal(result.body.import.addedRows, 1);
  const entry = await prisma.monthlyCustomerDataEntry.findFirstOrThrow({
    where: { vin, dataset: { is: { ccmId, year: 2026, month: 9 } } },
  });
  assert.equal(entry.vehicleId, vehicle.id);
  assert.equal(entry.customerId, customer.id);
  assert.equal(await prisma.vehicle.count({ where: { physicalVehicleId: physical.id, ccmId } }), 1);
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).vin, legacyVin);
  assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } })).vehicleId, vehicle.id);
  const importBatch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.body.import.importBatchId } });
  assert.equal(importBatch.importType, 'monthly_customer_data');
  assert.equal(importBatch.rollbackSupported, true);
  assert.ok(await prisma.importChangeLog.count({ where: { importBatchId: importBatch.id, entityType: 'MonthlyCustomerDataEntry' } }));

  const deletionPreview = await deletionService.previewPermanentImportDeletion(importBatch.id);
  assert.equal(deletionPreview.blockers.length, 0);
  assert.ok(deletionPreview.physicalVehicleIdentitiesRetained.some(({ vin: retainedVin }) => retainedVin === vin));
  const deletionResult = await deletionService.permanentlyDeleteImportBatch(
    importBatch.id,
    admin.id,
    deletionPreview.confirmationToken,
  );
  assert.equal(deletionResult.summary.totalRecordsDeleted, 2);
  assert.equal(await prisma.monthlyCustomerDataEntry.count({ where: { id: entry.id } }), 0);
  assert.equal(await prisma.customer.count({ where: { id: customer.id } }), 1);
  assert.equal(await prisma.vehicle.count({ where: { id: vehicle.id } }), 1);
  assert.ok(await prisma.physicalVehicle.findUnique({ where: { id: physical.id } }));
  assert.equal((await prisma.monthlyCustomerDataImport.findUniqueOrThrow({ where: { importBatchId: importBatch.id } })).status, 'permanently_deleted');
});

test('permanent deletion rebases a middle import while preserving the later customer update and service history', async () => {
  const ccmId = id('rebase-team');
  const admin = await createUser('rebase-admin', 'ADMIN');
  await createUser('rebase-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registration = id('rebase-registration');
  const roA = id('rebase-ro-a');
  const roB = id('rebase-ro-b');
  const roC = id('rebase-ro-c');
  const importA = await importCsv(csvRow(roA, vin, registration, 'Old Name'), admin, ccmId);
  const importB = await importCsv(csvRow(roB, vin, registration, 'Updated Name'), admin, ccmId);
  const vehicleAfterBImport = await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin } });
  const customerAfterBImport = await prisma.customer.findUniqueOrThrow({ where: { id: vehicleAfterBImport.customerId } });
  await applyTrackedImportUpdate(importB.body.batch.id, 'Customer', customerAfterBImport.id, ccmId, { fullName: 'Updated Name' });
  await applyTrackedImportUpdate(importB.body.batch.id, 'Vehicle', vehicleAfterBImport.id, ccmId, { saleDate: new Date('2022-10-10T00:00:00.000Z') });
  const importC = await importCsv(csvRow(roC, vin, registration, 'Latest Name'), admin, ccmId);
  await applyTrackedImportUpdate(importC.body.batch.id, 'Customer', customerAfterBImport.id, ccmId, { fullName: 'Latest Name' });
  await applyTrackedImportUpdate(importC.body.batch.id, 'Vehicle', vehicleAfterBImport.id, ccmId, { model: 'Later Model' });
  assert.equal(importA.statusCode, 201, JSON.stringify(importA.body));
  assert.equal(importB.statusCode, 201, JSON.stringify(importB.body));
  assert.equal(importC.statusCode, 201, JSON.stringify(importC.body));

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerAfterBImport.id } });
  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleAfterBImport.id } });
  const physical = await prisma.physicalVehicle.findUniqueOrThrow({ where: { vin } });
  assert.equal(customer.fullName, 'Latest Name');
  assert.equal(vehicle.saleDate.toISOString(), '2022-10-10T00:00:00.000Z');
  assert.equal(vehicle.model, 'Later Model');
  const beforeDeletionVisitIds = await prisma.workshopVisit.findMany({
    where: { ccmId, physicalVehicleId: physical.id },
    select: { repairOrderNo: true },
  });
  assert.deepEqual(new Set(beforeDeletionVisitIds.map(({ repairOrderNo }) => repairOrderNo)), new Set([roA, roB, roC]));

  const earliestPreview = await deletionService.previewPermanentImportDeletion(importA.body.batch.id);
  assert.equal(earliestPreview.confirmationToken, null);
  assert.ok(earliestPreview.blockers.some(({ code }) => code === 'later-import-modification'));

  const middleBatchId = importB.body.batch.id;
  const preview = await deletionService.previewPermanentImportDeletion(middleBatchId);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));
  assert.ok(preview.confirmationToken);
  const result = await deletionService.permanentlyDeleteImportBatch(middleBatchId, admin.id, preview.confirmationToken);

  assert.equal(result.summary.totalRecordsDeleted, 1);
  assert.ok(result.summary.existingRecordsRebased >= 1);
  assert.equal(result.summary.existingRecordsRestored, 1);
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).fullName, 'Latest Name');
  const restoredVehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
  assert.equal(restoredVehicle.saleDate, null);
  assert.equal(restoredVehicle.model, 'Later Model');
  assert.deepEqual(
    new Set((await prisma.workshopVisit.findMany({
      where: { ccmId, physicalVehicleId: physical.id },
      select: { repairOrderNo: true },
    })).map(({ repairOrderNo }) => repairOrderNo)),
    new Set([roA, roC]),
  );
  const survivingUpdate = await prisma.importChangeLog.findFirstOrThrow({
    where: { importBatchId: importC.body.batch.id, entityType: 'Customer', entityId: customer.id },
  });
  assert.equal(survivingUpdate.before.fullName, 'Old Name');
  assert.equal(await prisma.physicalVehicle.count({ where: { id: physical.id } }), 1);
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: importA.body.batch.id } })).status, 'completed');
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: importC.body.batch.id } })).status, 'completed');

  const latestPreview = await deletionService.previewPermanentImportDeletion(importC.body.batch.id);
  assert.equal(latestPreview.blockers.length, 0, JSON.stringify(latestPreview.blockers));
  await deletionService.permanentlyDeleteImportBatch(importC.body.batch.id, admin.id, latestPreview.confirmationToken);
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).fullName, 'Old Name');
  const afterLatestDeletion = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
  assert.equal(afterLatestDeletion.saleDate, null);
  assert.equal(afterLatestDeletion.model, 'Test');
  assert.deepEqual(
    (await prisma.workshopVisit.findMany({
      where: { ccmId, physicalVehicleId: physical.id },
      select: { repairOrderNo: true },
    })).map(({ repairOrderNo }) => repairOrderNo),
    [roA],
  );

  const earliestAfterReversals = await deletionService.previewPermanentImportDeletion(importA.body.batch.id);
  assert.equal(earliestAfterReversals.blockers.length, 0, JSON.stringify(earliestAfterReversals.blockers));
  await deletionService.permanentlyDeleteImportBatch(importA.body.batch.id, admin.id, earliestAfterReversals.confirmationToken);
  assert.equal(await prisma.customer.findUnique({ where: { id: customer.id } }), null);
  assert.equal(await prisma.vehicle.findUnique({ where: { id: vehicle.id } }), null);
  assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id, ccmId } }), 0);
  assert.equal(await prisma.physicalVehicle.count({ where: { id: physical.id } }), 1);
});

test('permanent deletion of the latest import restores earlier values and keeps earlier service history', async () => {
  const ccmId = id('latest-team');
  const admin = await createUser('latest-admin', 'ADMIN');
  await createUser('latest-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registration = id('latest-registration');
  const roA = id('latest-ro-a');
  const roB = id('latest-ro-b');
  const importA = await importCsv(csvRow(roA, vin, registration, 'Original Name'), admin, ccmId);
  const importB = await importCsv(csvRow(roB, vin, registration, 'Imported Name'), admin, ccmId);
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin } });
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: vehicle.customerId } });
  await applyTrackedImportUpdate(importB.body.batch.id, 'Customer', customer.id, ccmId, { fullName: 'Latest Import Name' });
  assert.equal(importA.statusCode, 201);
  assert.equal(importB.statusCode, 201);

  const preview = await deletionService.previewPermanentImportDeletion(importB.body.batch.id);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));
  await deletionService.permanentlyDeleteImportBatch(importB.body.batch.id, admin.id, preview.confirmationToken);

  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).fullName, 'Original Name');
  assert.deepEqual(
    (await prisma.workshopVisit.findMany({ where: { ccmId, vehicleId: vehicle.id }, select: { repairOrderNo: true } }))
      .map(({ repairOrderNo }) => repairOrderNo),
    [roA],
  );
});

test('deleting one CCM import preserves another CCM vehicle and shared physical identity', async () => {
  const ccmAId = id('shared-delete-ccm-a');
  const ccmBId = id('shared-delete-ccm-b');
  const admin = await createUser('shared-delete-admin', 'ADMIN');
  await createUser('shared-delete-ccm-a-user', 'CCM', ccmAId);
  await createUser('shared-delete-ccm-b-user', 'CCM', ccmBId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registration = id('shared-delete-registration');
  const importA = await importCsv(csvRow(id('shared-delete-ro-a'), vin, registration, 'CCM A'), admin, ccmAId);
  const importB = await importCsv(csvRow(id('shared-delete-ro-b'), vin, registration, 'CCM B'), admin, ccmBId);
  assert.equal(importA.statusCode, 201, JSON.stringify(importA.body));
  assert.equal(importB.statusCode, 201, JSON.stringify(importB.body));
  const [vehicleA, vehicleB] = await Promise.all([
    prisma.vehicle.findFirstOrThrow({ where: { ccmId: ccmAId, vin } }),
    prisma.vehicle.findFirstOrThrow({ where: { ccmId: ccmBId, vin } }),
  ]);
  const physical = await prisma.physicalVehicle.findUniqueOrThrow({ where: { vin } });
  assert.equal(vehicleA.physicalVehicleId, physical.id);
  assert.equal(vehicleB.physicalVehicleId, physical.id);

  const preview = await deletionService.previewPermanentImportDeletion(importB.body.batch.id);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));
  const result = await deletionService.permanentlyDeleteImportBatch(importB.body.batch.id, admin.id, preview.confirmationToken);

  assert.equal(await prisma.vehicle.findUnique({ where: { id: vehicleA.id } }) !== null, true);
  assert.equal(await prisma.customer.count({ where: { ccmId: ccmAId } }), 1);
  assert.equal(await prisma.vehicle.findUnique({ where: { id: vehicleB.id } }), null);
  assert.equal(await prisma.customer.count({ where: { ccmId: ccmBId } }), 0);
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId: ccmAId, physicalVehicleId: physical.id } }), 1);
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId: ccmBId, physicalVehicleId: physical.id } }), 0);
  assert.equal(await prisma.physicalVehicle.count({ where: { id: physical.id } }), 1);
  assert.ok(result.summary.physicalVehicleIdentitiesRetained.some(({ vin: retainedVin }) => retainedVin === vin));
});

test('permanent deletion is safe under concurrent and repeated confirmation', async () => {
  const ccmId = id('repeat-delete-team');
  const admin = await createUser('repeat-delete-admin', 'ADMIN');
  await createUser('repeat-delete-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const imported = await importCsv(csvRow(id('repeat-delete-ro'), vin, id('repeat-delete-registration')), admin, ccmId);
  assert.equal(imported.statusCode, 201, JSON.stringify(imported.body));
  const batchId = imported.body.batch.id;
  const preview = await deletionService.previewPermanentImportDeletion(batchId);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));

  const concurrentResults = await Promise.allSettled([
    deletionService.permanentlyDeleteImportBatch(batchId, admin.id, preview.confirmationToken),
    deletionService.permanentlyDeleteImportBatch(batchId, admin.id, preview.confirmationToken),
  ]);
  assert.ok(concurrentResults.some(({ status }) => status === 'fulfilled'));
  const repeated = await deletionService.permanentlyDeleteImportBatch(batchId, admin.id, preview.confirmationToken);
  assert.equal(repeated.alreadyDeleted, true);
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).status, 'permanently_deleted');
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicle: { is: { vin } } } }), 0);
  assert.equal(await prisma.vehicle.count({ where: { ccmId, vin } }), 0);
});

test('permanent deletion transaction failure leaves business records and batch status unchanged', async () => {
  const ccmId = id('atomic-delete-team');
  const admin = await createUser('atomic-delete-admin', 'ADMIN');
  await createUser('atomic-delete-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const imported = await importCsv(csvRow(id('atomic-delete-ro'), vin, id('atomic-delete-registration')), admin, ccmId);
  assert.equal(imported.statusCode, 201, JSON.stringify(imported.body));
  const batchId = imported.body.batch.id;
  const preview = await deletionService.previewPermanentImportDeletion(batchId);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));
  const auditCountBefore = await prisma.auditLog.count({ where: { entityType: 'ImportBatch', entityId: batchId } });

  const failingDatabase = {
    $transaction(callback, options) {
      return prisma.$transaction((transaction) => callback(new Proxy(transaction, {
        get(target, property) {
          if (property === 'importBatch') {
            return new Proxy(target.importBatch, {
              get(delegate, operation) {
                if (operation === 'update') {
                  return async (args) => {
                    if (args.data?.status === 'permanently_deleted') {
                      throw new Error('Injected failure before import status update.');
                    }
                    return Reflect.get(delegate, operation, delegate).call(delegate, args);
                  };
                }
                const value = Reflect.get(delegate, operation, delegate);
                return typeof value === 'function' ? value.bind(delegate) : value;
              },
            });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })), options);
    },
  };
  await assert.rejects(
    deletionService.permanentlyDeleteImportBatch(batchId, admin.id, preview.confirmationToken, failingDatabase),
    /Injected failure before import status update/,
  );

  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).status, 'completed');
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicle: { is: { vin } } } }), 1);
  assert.equal(await prisma.vehicle.count({ where: { ccmId, vin } }), 1);
  assert.equal(await prisma.customer.count({ where: { ccmId } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { entityType: 'ImportBatch', entityId: batchId } }), auditCountBefore);
});

test('permanent deletion allows a verified empty import and reports zero changed records', async () => {
  const ccmId = id('empty-delete-team');
  const admin = await createUser('empty-delete-admin', 'ADMIN');
  const batch = await prisma.importBatch.create({
    data: {
      id: id('empty-delete-batch'),
      fileName: 'empty-import.csv',
      importedByUserId: admin.id,
      ccmId,
      processingStartedAt: new Date(),
      totalRows: 0,
      status: 'completed',
      statsComplete: true,
      affectedCountsComplete: true,
    },
  });
  const preview = await deletionService.previewPermanentImportDeletion(batch.id);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));
  assert.equal(preview.totalRecordsDeleted, 0);
  const result = await deletionService.permanentlyDeleteImportBatch(batch.id, admin.id, preview.confirmationToken);
  assert.equal(result.summary.totalRecordsDeleted, 0);
  assert.equal(result.summary.directlyAffectedRecords, 0);
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status, 'permanently_deleted');
});

test('permanent deletion blocks incomplete evidence and non-import edits without changing records', async () => {
  const ccmId = id('provenance-block-team');
  const admin = await createUser('provenance-block-admin', 'ADMIN');
  await createUser('provenance-block-ccm', 'CCM', ccmId);

  const missingEvidenceRo = id('missing-evidence-ro');
  const missingEvidenceVin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const missingEvidenceImport = await importCsv(csvRow(missingEvidenceRo, missingEvidenceVin, id('missing-evidence-registration')), admin, ccmId);
  assert.equal(missingEvidenceImport.statusCode, 201);
  const missingEvidenceVisit = await prisma.workshopVisit.findFirstOrThrow({
    where: { ccmId, repairOrderNo: missingEvidenceRo },
  });
  await prisma.importChangeLog.deleteMany({ where: { importBatchId: missingEvidenceImport.body.batch.id } });
  const incompletePreview = await deletionService.previewPermanentImportDeletion(missingEvidenceImport.body.batch.id);
  assert.equal(incompletePreview.confirmationToken, null);
  assert.ok(incompletePreview.blockers.some(({ code }) => code === 'incomplete-import-evidence'));
  assert.ok(await prisma.workshopVisit.findUnique({ where: { id: missingEvidenceVisit.id } }));
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: missingEvidenceImport.body.batch.id } })).status, 'completed');

  const manualVin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const manualImport = await importCsv(csvRow(id('manual-edit-ro'), manualVin, id('manual-edit-registration'), 'Before Manual Edit'), admin, ccmId);
  assert.equal(manualImport.statusCode, 201);
  const manualVehicle = await prisma.vehicle.findFirstOrThrow({
    where: { ccmId, vin: manualVin },
    include: { customer: true },
  });
  await prisma.customer.update({
    where: { id: manualVehicle.customerId },
    data: { fullName: 'Edited outside the import' },
  });
  const manualPreview = await deletionService.previewPermanentImportDeletion(manualImport.body.batch.id);
  assert.equal(manualPreview.confirmationToken, null);
  assert.ok(manualPreview.blockers.some(({ code }) => code === 'snapshot-mismatch'));
  assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: manualVehicle.customerId } })).fullName, 'Edited outside the import');
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: manualImport.body.batch.id } })).status, 'completed');
});

test('composite milestone reference rejects a workshop visit belonging to another vehicle', async () => {
  const team = id('fk-team');
  const customer = await createCustomer('fk-customer', team);
  const vehicleA = await createVehicle('fk-vehicle-a', customer, team);
  const vehicleB = await createVehicle('fk-vehicle-b', customer, team);
  const visit = await createWorkshopVisit('fk-visit', customer, vehicleA, team, id('fk-ro'), new Date());
  await prisma.freeServiceMilestone.create({
    data: {
      id: id('fk-milestone-valid'),
      vehicle: { connect: { id: vehicleA.id } },
      physicalVehicle: { connect: { id: vehicleA.physicalVehicleId } },
      milestone: 1,
      dueDate: new Date(),
      completedByWorkshopVisit: {
        connect: {
          id_physicalVehicleId: {
            id: visit.id,
            physicalVehicleId: vehicleA.physicalVehicleId,
          },
        },
      },
    },
  });
  await assert.rejects(
    prisma.freeServiceMilestone.create({
      data: {
        id: id('fk-milestone-invalid'),
        vehicle: { connect: { id: vehicleB.id } },
        physicalVehicle: { connect: { id: vehicleB.physicalVehicleId } },
        milestone: 1,
        dueDate: new Date(),
        completedByWorkshopVisit: {
          connect: {
            id_physicalVehicleId: {
              id: visit.id,
              physicalVehicleId: vehicleA.physicalVehicleId,
            },
          },
        },
      },
    }),
    (error) => error?.code === 'P2003',
  );
});

test('milestone backfill SQL only resolves unique same-vehicle normalized RO matches', async () => {
  const teamA = id('backfill-team-a');
  const teamB = id('backfill-team-b');
  const customerA = id('backfill-customer-a');
  const customerB = id('backfill-customer-b');
  const vehicleA = id('backfill-vehicle-a');
  const vehicleB = id('backfill-vehicle-b');
  const uniqueRo = id('backfill-unique-ro').toUpperCase();
  const ambiguousRo = id('backfill-ambiguous-ro').toUpperCase();
  const crossVehicleRo = id('backfill-cross-vehicle-ro').toUpperCase();
  const unmatchedRo = id('backfill-unmatched-ro').toUpperCase();
  const physicalA = id('backfill-physical-a');
  const physicalB = id('backfill-physical-b');
  const ids = {
    uniqueVisit: id('backfill-unique-visit'),
    ambiguousVisitA: id('backfill-ambiguous-visit-a'),
    ambiguousVisitB: id('backfill-ambiguous-visit-b'),
    crossVehicleVisit: id('backfill-cross-vehicle-visit'),
    uniqueMilestone: id('backfill-unique-milestone'),
    ambiguousMilestone: id('backfill-ambiguous-milestone'),
    crossVehicleMilestone: id('backfill-cross-vehicle-milestone'),
    unmatchedMilestone: id('backfill-unmatched-milestone'),
  };
  await verificationClient.query('BEGIN');
  try {
    await verificationClient.query(
      `INSERT INTO customers (id, "customerCode", "fullName", "updatedAt")
       VALUES ($1, $2, 'Backfill A', CURRENT_TIMESTAMP), ($3, $4, 'Backfill B', CURRENT_TIMESTAMP)`,
      [customerA, id('backfill-customer-code-a'), customerB, id('backfill-customer-code-b')],
    );
    await verificationClient.query(
      `INSERT INTO physical_vehicles (id, vin, "updatedAt")
       VALUES ($1, $2, CURRENT_TIMESTAMP), ($3, $4, CURRENT_TIMESTAMP)`,
      [physicalA, id('backfill-vin-a'), physicalB, id('backfill-vin-b')],
    );
    await verificationClient.query(
      `INSERT INTO vehicles (id, vin, "physicalVehicleId", "customerId", "ccmId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP), ($6, $7, $8, $9, $5, CURRENT_TIMESTAMP)`,
      [vehicleA, id('backfill-vin-a'), physicalA, customerA, teamA, vehicleB, id('backfill-vin-b'), physicalB, customerB],
    );
    await verificationClient.query(
      `INSERT INTO workshop_visits (id, "repairOrderNo", "normalizedRepairOrderNo", "customerId", "vehicleId", "physicalVehicleId", "ccmId", "updatedAt")
       VALUES ($1, $2, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP),
              ($7, $8, $9, $3, $4, $5, $6, CURRENT_TIMESTAMP),
              ($10, $11, $9, $3, $4, $5, $12, CURRENT_TIMESTAMP),
              ($13, $14, $15, $16, $17, $18, $6, CURRENT_TIMESTAMP)`,
      [
        ids.uniqueVisit, uniqueRo, customerA, vehicleA, physicalA, teamA,
        ids.ambiguousVisitA, ambiguousRo, ambiguousRo,
        ids.ambiguousVisitB, `${ambiguousRo}-OTHER-CCM`, teamB,
        ids.crossVehicleVisit, crossVehicleRo, crossVehicleRo, customerB, vehicleB, physicalB,
      ],
    );
    await verificationClient.query(
      `INSERT INTO free_service_milestones (id, "vehicleId", "physicalVehicleId", milestone, "dueDate", status, "completedByRepairOrderNo", "updatedAt")
       VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP, 'completed', $4, CURRENT_TIMESTAMP),
              ($5, $2, $3, 2, CURRENT_TIMESTAMP, 'completed', $6, CURRENT_TIMESTAMP),
              ($7, $8, $9, 1, CURRENT_TIMESTAMP, 'completed', $10, CURRENT_TIMESTAMP),
              ($11, $8, $9, 2, CURRENT_TIMESTAMP, 'completed', $12, CURRENT_TIMESTAMP)`,
      [
        ids.uniqueMilestone, vehicleA, physicalA, uniqueRo,
        ids.ambiguousMilestone, ambiguousRo,
        ids.crossVehicleMilestone, vehicleB, physicalB, crossVehicleRo,
        ids.unmatchedMilestone, unmatchedRo,
      ],
    );
    await verificationClient.query(
      `UPDATE free_service_milestones AS milestone
       SET "completedByWorkshopVisitId" = (
         SELECT visit."id"
         FROM "workshop_visits" AS visit
         WHERE visit."vehicleId" = milestone."vehicleId"
           AND visit."normalizedRepairOrderNo" =
             UPPER(BTRIM(REGEXP_REPLACE(milestone."completedByRepairOrderNo", '[[:space:]]+', ' ', 'g')))
         LIMIT 1
       )
       WHERE milestone."completedByRepairOrderNo" IS NOT NULL
         AND (
           SELECT COUNT(*)
           FROM "workshop_visits" AS visit
           WHERE visit."vehicleId" = milestone."vehicleId"
             AND visit."normalizedRepairOrderNo" =
               UPPER(BTRIM(REGEXP_REPLACE(milestone."completedByRepairOrderNo", '[[:space:]]+', ' ', 'g')))
         ) = 1`,
    );
    const result = await verificationClient.query(
      'SELECT id, "completedByWorkshopVisitId" FROM free_service_milestones WHERE id = ANY($1)',
      [[ids.uniqueMilestone, ids.ambiguousMilestone, ids.crossVehicleMilestone, ids.unmatchedMilestone]],
    );
    const references = new Map(result.rows.map(({ id: milestoneId, completedByWorkshopVisitId }) => [milestoneId, completedByWorkshopVisitId]));
    assert.equal(references.get(ids.uniqueMilestone), ids.uniqueVisit);
    assert.equal(references.get(ids.ambiguousMilestone), null);
    assert.equal(references.get(ids.crossVehicleMilestone), ids.crossVehicleVisit);
    assert.equal(references.get(ids.unmatchedMilestone), null);
  } finally {
    await verificationClient.query('ROLLBACK');
  }
});

test('import rollback removes only the exact referenced visit when another CCM has the same RO', async () => {
  const teamA = id('rollback-team-a');
  const teamB = id('rollback-team-b');
  const admin = await createUser('rollback-admin', 'ADMIN');
  const customer = await createCustomer('rollback-customer', teamA);
  const vehicle = await createVehicle('rollback-vehicle', customer, teamA);
  const repairOrder = id('rollback-shared-ro').toUpperCase();
  const targetVisit = await createWorkshopVisit('rollback-target-visit', customer, vehicle, teamA, repairOrder, new Date());
  const retainedVisit = await createWorkshopVisit('rollback-retained-visit', customer, vehicle, teamB, repairOrder, new Date());
  const milestone = await prisma.freeServiceMilestone.create({
    data: {
      id: id('rollback-milestone'),
      vehicle: { connect: { id: vehicle.id } },
      physicalVehicle: { connect: { id: vehicle.physicalVehicleId } },
      milestone: 1,
      dueDate: new Date(),
      completedByWorkshopVisit: {
        connect: {
          id_physicalVehicleId: {
            id: retainedVisit.id,
            physicalVehicleId: vehicle.physicalVehicleId,
          },
        },
      },
    },
  });
  const batch = await createVisitImportEvidence('rollback-exact-identity', admin, teamA, targetVisit);

  const result = await rollbackService.rollbackImportBatch(batch.id, admin.id);

  assert.equal(result.batch.status, 'rolled_back');
  assert.equal(await prisma.workshopVisit.findUnique({ where: { id: targetVisit.id } }), null);
  assert.equal((await prisma.workshopVisit.findUniqueOrThrow({ where: { id: retainedVisit.id } })).id, retainedVisit.id);
  assert.equal((await prisma.freeServiceMilestone.findUniqueOrThrow({ where: { id: milestone.id } })).completedByWorkshopVisitId, retainedVisit.id);
});

test('permanent import deletion removes only the exact visit and preserves a same-number visit and its milestone', async () => {
  const teamA = id('deletion-team-a');
  const teamB = id('deletion-team-b');
  const admin = await createUser('deletion-admin', 'ADMIN');
  const customer = await createCustomer('deletion-customer', teamA);
  const vehicle = await createVehicle('deletion-vehicle', customer, teamA);
  const repairOrder = id('deletion-shared-ro').toUpperCase();
  const targetVisit = await createWorkshopVisit('deletion-target-visit', customer, vehicle, teamA, repairOrder, new Date());
  const retainedVisit = await createWorkshopVisit('deletion-retained-visit', customer, vehicle, teamB, repairOrder, new Date());
  const milestone = await prisma.freeServiceMilestone.create({
    data: {
      id: id('deletion-milestone'),
      vehicle: { connect: { id: vehicle.id } },
      physicalVehicle: { connect: { id: vehicle.physicalVehicleId } },
      milestone: 1,
      dueDate: new Date(),
      completedByWorkshopVisit: {
        connect: {
          id_physicalVehicleId: {
            id: retainedVisit.id,
            physicalVehicleId: vehicle.physicalVehicleId,
          },
        },
      },
    },
  });
  const batch = await createVisitImportEvidence('deletion-exact-identity', admin, teamA, targetVisit);
  const preview = await deletionService.previewPermanentImportDeletion(batch.id);
  assert.equal(preview.deletionBlocked, false);
  assert.equal(preview.willDelete.length, 1);
  assert.equal(preview.willDelete[0].entityId, targetVisit.id);

  const result = await deletionService.permanentlyDeleteImportBatch(
    batch.id,
    admin.id,
    preview.confirmationToken,
  );

  assert.equal(result.status, 'permanently_deleted');
  assert.equal(await prisma.workshopVisit.findUnique({ where: { id: targetVisit.id } }), null);
  assert.equal((await prisma.workshopVisit.findUniqueOrThrow({ where: { id: retainedVisit.id } })).id, retainedVisit.id);
  assert.equal((await prisma.freeServiceMilestone.findUniqueOrThrow({ where: { id: milestone.id } })).completedByWorkshopVisitId, retainedVisit.id);
});

test('CRE assignment history rejects UPDATE, DELETE, and TRUNCATE in PostgreSQL', async () => {
  const team = id('history-team');
  const actor = await createUser('history-actor', 'CCM', team);
  const customer = await createCustomer('history-customer', team);
  const vehicle = await createVehicle('history-vehicle', customer, team);
  const cre = await createUser('history-cre', 'CRE', team);
  const allocation = await prisma.allocation.create({
    data: {
      id: id('history-allocation'),
      vehicleId: vehicle.id,
      creId: cre.id,
      ccmId: team,
      serviceType: 'integration',
    },
  });
  const event = await prisma.creAssignmentHistory.create({
    data: {
      vehicleId: vehicle.id,
      allocationId: allocation.id,
      ccmId: team,
      newCreId: cre.id,
      actorUserId: actor.id,
      eventType: 'ASSIGNED',
    },
  });

  for (const statement of [
    `UPDATE cre_assignment_history SET reason = 'changed' WHERE id = '${event.id}'`,
    `DELETE FROM cre_assignment_history WHERE id = '${event.id}'`,
    'TRUNCATE TABLE cre_assignment_history',
  ]) {
    const isolated = new PgClient({ connectionString: databaseUrl });
    await isolated.connect();
    try {
      await isolated.query('BEGIN');
      await assert.rejects(isolated.query(statement));
    } finally {
      await isolated.query('ROLLBACK');
      await isolated.end();
    }
  }
  assert.equal(await prisma.creAssignmentHistory.count({ where: { id: event.id } }), 1);
});

test('PostgreSQL advisory lock used by allocation teams blocks a second connection until commit', async () => {
  const ccmId = id('lock-team');
  const blocker = new PgClient({ connectionString: databaseUrl });
  const waiter = new PgClient({ connectionString: databaseUrl });
  await Promise.all([blocker.connect(), waiter.connect()]);
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`customer-allocation:${ccmId}`],
    );
    const waitingQuery = waiter.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`customer-allocation:${ccmId}`],
    );
    await waitForAdvisoryLockWaiters(1);
    await blocker.query('COMMIT');
    await waitingQuery;
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await Promise.all([blocker.end(), waiter.end()]);
  }
});

test('concurrent VIN/CCM creation serializes and the call list consolidates duplicates while retaining visit history', async () => {
  const team = id('mcl-team');
  const ccm = await createUser('mcl-ccm', 'CCM', team);
  const customer = await createCustomer('mcl-customer', team, '5550100');
  const vehicle = await createVehicle('mcl-vehicle', customer, team);
  const createOrGetCanonical = () => prisma.$transaction(async (transaction) => {
    const existing = await masterCallList.findCanonicalMasterCallListEntry(transaction, vehicle.vin, team);
    if (existing) return existing;
    return transaction.masterCallList.create({
      data: {
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber,
        vin: vehicle.vin,
        vehicleId: vehicle.id,
        ccmId: team,
      },
    });
  });
  const [first, second] = await Promise.all([createOrGetCanonical(), createOrGetCanonical()]);
  assert.equal(first.id, second.id);
  await prisma.masterCallList.createMany({
    data: [
      { customerName: customer.fullName, mobileNumber: customer.mobileNumber, vin: vehicle.vin, vehicleId: vehicle.id, ccmId: team },
      { customerName: customer.fullName, mobileNumber: customer.mobileNumber, vin: vehicle.vin, vehicleId: vehicle.id, ccmId: team },
    ],
  });
  const [older, latest] = await Promise.all([
    createWorkshopVisit('mcl-visit-old', customer, vehicle, team, 'MCL-OLD', new Date('2024-01-01T00:00:00Z')),
    createWorkshopVisit('mcl-visit-latest', customer, vehicle, team, 'MCL-LATEST', new Date('2025-01-01T00:00:00Z')),
  ]);
  const [firstUpdate, secondUpdate] = await Promise.all([
    prisma.$transaction(async (transaction) => {
      const canonical = await masterCallList.findCanonicalMasterCallListEntry(transaction, vehicle.vin, team);
      return transaction.masterCallList.update({ where: { id: canonical.id }, data: { customerName: 'Concurrent import A' } });
    }),
    prisma.$transaction(async (transaction) => {
      const canonical = await masterCallList.findCanonicalMasterCallListEntry(transaction, vehicle.vin, team);
      return transaction.masterCallList.update({ where: { id: canonical.id }, data: { customerName: 'Concurrent import B' } });
    }),
  ]);
  assert.equal(firstUpdate.id, secondUpdate.id);
  const result = await runController(recordsController.getCallList, { user: ccm, query: {} });
  const visible = result.body.records.filter((record) => record.vin === vehicle.vin);
  assert.equal(visible.length, 1);
  assert.deepEqual(new Set(visible[0].workshopVisits.map(({ id: visitId }) => visitId)), new Set([older.id, latest.id]));
  assert.equal(visible[0].workshopVisits[0].id, latest.id);
  assert.equal(await prisma.masterCallList.count({ where: { vin: vehicle.vin, ccmId: team } }), 3);
});

test('deactivation exposes MCL-backed and allocation-only work to its CCM and both can be reassigned', async () => {
  const team = id('queue-team');
  const otherTeam = id('queue-other-team');
  const ccm = await createUser('queue-ccm', 'CCM', team);
  const oldCre = await createUser('queue-old-cre', 'CRE', team);
  const newCre = await createUser('queue-new-cre', 'CRE', team);
  const otherCcm = await createUser('queue-other-ccm', 'CCM', otherTeam);
  const otherCre = await createUser('queue-other-cre', 'CRE', otherTeam);
  const backedCustomer = await createCustomer('queue-backed-customer', team, '5550200');
  const backedVehicle = await createVehicle('queue-backed-vehicle', backedCustomer, team);
  const allocationOnlyCustomer = await createCustomer('queue-only-customer', team);
  const allocationOnlyVehicle = await createVehicle('queue-only-vehicle', allocationOnlyCustomer, team);
  const otherCustomer = await createCustomer('queue-other-customer', otherTeam, '5550300');
  const otherVehicle = await createVehicle('queue-other-vehicle', otherCustomer, otherTeam);
  const backedEntry = await prisma.masterCallList.create({
    data: {
      customerName: backedCustomer.fullName,
      mobileNumber: backedCustomer.mobileNumber,
      vin: backedVehicle.vin,
      vehicleId: backedVehicle.id,
      ccmId: team,
      ownerUserId: oldCre.id,
    },
  });
  const backedAllocation = await prisma.allocation.create({
    data: { vehicleId: backedVehicle.id, creId: oldCre.id, ccmId: team, serviceType: 'backed' },
  });
  const allocationOnly = await prisma.allocation.create({
    data: { vehicleId: allocationOnlyVehicle.id, creId: oldCre.id, ccmId: team, serviceType: 'allocation-only' },
  });
  await prisma.allocation.create({
    data: { vehicleId: otherVehicle.id, creId: otherCre.id, ccmId: otherTeam, serviceType: 'other-team' },
  });

  const deactivated = await runController(userController.updateUserStatus, {
    params: { id: oldCre.id },
    user: ccm,
    body: { status: 'inactive', reason: 'integration test' },
  });
  assert.equal(deactivated.statusCode, 200);
  assert.equal((await prisma.allocation.findUnique({ where: { id: backedAllocation.id } })).creId, null);
  assert.equal((await prisma.allocation.findUnique({ where: { id: allocationOnly.id } })).creId, null);
  assert.equal((await prisma.masterCallList.findUnique({ where: { id: backedEntry.id } })).ownerUserId, null);

  const queue = await runController(recordsController.getCallList, { user: ccm, query: {} });
  const teamRecords = queue.body.records.filter(({ ccmId }) => ccmId === team);
  assert.equal(teamRecords.filter(({ vin }) => vin === backedVehicle.vin).length, 1);
  assert.equal(teamRecords.filter(({ vin }) => vin === allocationOnlyVehicle.vin).length, 1);
  assert.equal(teamRecords.some(({ vin }) => vin === otherVehicle.vin), false);
  assert.equal(teamRecords.find(({ vin }) => vin === allocationOnlyVehicle.vin).mobile, null);

  for (const allocation of [backedAllocation, allocationOnly]) {
    const reassigned = await runController(allocationController.updateAllocation, {
      params: { id: allocation.id },
      user: ccm,
      body: { creId: newCre.id, status: 'assigned' },
    });
    assert.equal(reassigned.statusCode, 200);
    assert.equal(reassigned.body.allocation.creId, newCre.id);
  }
  await prisma.user.findUniqueOrThrow({ where: { id: otherCcm.id } });
});

test('CRE transfer and allocation transactions serialize without assigning under a former CCM', async () => {
  const oldTeam = id('race-old-team');
  const newTeam = id('race-new-team');
  const actor = await createUser('race-admin', 'ADMIN');
  await createUser('race-old-ccm', 'CCM', oldTeam);
  await createUser('race-new-ccm', 'CCM', newTeam);
  const cre = await createUser('race-cre', 'CRE', oldTeam);
  const customer = await createCustomer('race-customer', oldTeam);
  const vehicle = await createVehicle('race-vehicle', customer, oldTeam);

  const [transfer, allocation] = await Promise.all([
    transferCre(cre, actor, newTeam),
    createAllocation(vehicle, cre, actor, 'race-service'),
  ]);
  const currentCre = await prisma.user.findUniqueOrThrow({ where: { id: cre.id } });
  const committedAllocations = await prisma.allocation.findMany({ where: { vehicleId: vehicle.id, status: 'assigned' } });
  if (currentCre.ccmId === newTeam) {
    assert.equal(transfer.statusCode, 200);
    assert.notEqual(allocation.statusCode, 201);
    assert.equal(committedAllocations.length, 0);
  } else {
    assert.equal(currentCre.ccmId, oldTeam);
    assert.equal(allocation.statusCode, 201);
    assert.equal(committedAllocations.length, 1);
    assert.equal(committedAllocations[0].ccmId, oldTeam);
    assert.equal(transfer.statusCode, 409, JSON.stringify({ transfer: transfer.body, allocation: allocation.body }));
  }
});

test('a CRE transfer completed before allocation rejects the old-team allocation', async () => {
  const oldTeam = id('transfer-first-old');
  const newTeam = id('transfer-first-new');
  const actor = await createUser('transfer-first-admin', 'ADMIN');
  await createUser('transfer-first-old-ccm', 'CCM', oldTeam);
  await createUser('transfer-first-new-ccm', 'CCM', newTeam);
  const cre = await createUser('transfer-first-cre', 'CRE', oldTeam);
  const customer = await createCustomer('transfer-first-customer', oldTeam);
  const vehicle = await createVehicle('transfer-first-vehicle', customer, oldTeam);

  const transferred = await transferCre(cre, actor, newTeam);
  const allocated = await createAllocation(vehicle, cre, actor, 'transfer-first-service');
  assert.equal(transferred.statusCode, 200);
  assert.equal(allocated.statusCode, 400);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: cre.id } })).ccmId, newTeam);
  assert.equal(await prisma.allocation.count({ where: { vehicleId: vehicle.id } }), 0);
});

test('an allocation completed before transfer prevents CCM transfer', async () => {
  const oldTeam = id('allocation-first-old');
  const newTeam = id('allocation-first-new');
  const actor = await createUser('allocation-first-admin', 'ADMIN');
  await createUser('allocation-first-old-ccm', 'CCM', oldTeam);
  await createUser('allocation-first-new-ccm', 'CCM', newTeam);
  const cre = await createUser('allocation-first-cre', 'CRE', oldTeam);
  const customer = await createCustomer('allocation-first-customer', oldTeam);
  const vehicle = await createVehicle('allocation-first-vehicle', customer, oldTeam);

  const allocated = await createAllocation(vehicle, cre, actor, 'allocation-first-service');
  const transferred = await transferCre(cre, actor, newTeam);
  assert.equal(allocated.statusCode, 201);
  assert.equal(transferred.statusCode, 409);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: cre.id } })).ccmId, oldTeam);
  assert.equal(await prisma.allocation.count({ where: { vehicleId: vehicle.id, ccmId: oldTeam, creId: cre.id } }), 1);
});

test('two simultaneous CCM transfers cannot overwrite a stale CRE team assignment', async () => {
  const oldTeam = id('transfer-old-team');
  const teamA = id('transfer-a-team');
  const teamB = id('transfer-b-team');
  const actor = await createUser('transfer-admin', 'ADMIN');
  await createUser('transfer-old-ccm', 'CCM', oldTeam);
  await createUser('transfer-a-ccm', 'CCM', teamA);
  await createUser('transfer-b-ccm', 'CCM', teamB);
  const cre = await createUser('transfer-cre', 'CRE', oldTeam);

  const results = await Promise.all([
    transferCre(cre, actor, teamA),
    transferCre(cre, actor, teamB),
  ]);
  const stored = await prisma.user.findUniqueOrThrow({ where: { id: cre.id } });
  assert.ok([teamA, teamB].includes(stored.ccmId), JSON.stringify({ ccmId: stored.ccmId, results: results.map(({ statusCode, body }) => ({ statusCode, body })) }));
  assert.equal(results.filter(({ statusCode }) => statusCode === 200).length, 1);
  assert.equal(results.filter(({ statusCode }) => statusCode === 409).length, 1);
});

}
