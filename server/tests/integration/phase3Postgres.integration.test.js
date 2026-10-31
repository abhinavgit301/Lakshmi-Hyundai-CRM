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

const [{ prisma }, { Client: PgClient }, allocationController, userController, recordsController, callWorkflowController, masterCallList, rollbackService, deletionService] = await Promise.all([
  import('../../src/config/prisma.js'),
  import('pg'),
  import('../../src/controllers/allocationController.js'),
  import('../../src/controllers/userController.js'),
  import('../../src/controllers/recordsController.js'),
  import('../../src/controllers/callWorkflowController.js'),
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
    `${repairOrder},${vin},${name},5551000,Hyundai,Test,${registrationNumber ?? ''},2026-01-15`,
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

async function deleteCre(cre, actor) {
  return runController(userController.deleteManagedUser, {
    params: { id: cre.id },
    user: actor,
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

test('repair-order import updates a changed registration for the same VIN and preserves prior service history', async () => {
  const ccmId = id('mutable-registration-team');
  const admin = await createUser('mutable-registration-admin', 'ADMIN');
  await createUser('mutable-registration-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const oldRegistration = id('old-registration');
  const newRegistration = id('new-registration');
  const originalRo = id('mutable-registration-ro-original');
  const nextRo = id('mutable-registration-ro-next');

  const original = await importCsv(csvRow(originalRo, vin, oldRegistration), admin, ccmId);
  const previousVisit = await prisma.workshopVisit.findFirstOrThrow({
    where: { ccmId, physicalVehicle: { is: { vin } } },
  });
  const changed = await importCsv(csvRow(nextRo, vin, newRegistration), admin, ccmId);
  assert.equal(original.statusCode, 201);
  assert.equal(changed.statusCode, 201, JSON.stringify(changed.body));
  assert.equal(changed.body.batch.appendedRows, 1);

  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin } });
  assert.equal(vehicle.registrationNumber, newRegistration.toUpperCase());
  assert.equal(await prisma.vehicle.count({ where: { physicalVehicleId: vehicle.physicalVehicleId, ccmId } }), 1);
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicleId: vehicle.physicalVehicleId } }), 2);
  assert.ok(await prisma.workshopVisit.findUnique({ where: { id: previousVisit.id } }));
  const vehicleChange = await prisma.importChangeLog.findFirstOrThrow({
    where: { importBatchId: changed.body.batch.id, entityType: 'Vehicle', entityId: vehicle.id },
  });
  assert.equal(vehicleChange.before.registrationNumber, oldRegistration.toUpperCase());
  assert.equal(vehicleChange.after.registrationNumber, newRegistration.toUpperCase());
});

test('repair-order import accepts unchanged or missing registration without clearing the existing value', async () => {
  const ccmId = id('registration-optional-team');
  const admin = await createUser('registration-optional-admin', 'ADMIN');
  await createUser('registration-optional-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registration = id('registration-optional-value');
  const initial = await importCsv(csvRow(id('registration-optional-ro-initial'), vin, registration), admin, ccmId);
  const unchanged = await importCsv(csvRow(id('registration-optional-ro-unchanged'), vin, registration), admin, ccmId);
  const missing = await importCsv(csvRow(id('registration-optional-ro-missing'), vin, null), admin, ccmId);

  assert.equal(initial.statusCode, 201);
  assert.equal(unchanged.statusCode, 201, JSON.stringify(unchanged.body));
  assert.equal(missing.statusCode, 201, JSON.stringify(missing.body));
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin } });
  assert.equal(vehicle.registrationNumber, registration.toUpperCase());
  const callListEntry = await prisma.masterCallList.findFirstOrThrow({ where: { ccmId, vin } });
  assert.equal(callListEntry.registrationNumber, registration.toUpperCase());
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicleId: vehicle.physicalVehicleId } }), 3);
});

test('duplicate repair order updates a valid registration without duplicating service history and rollback restores it', async () => {
  const ccmId = id('registration-duplicate-team');
  const admin = await createUser('registration-duplicate-admin', 'ADMIN');
  await createUser('registration-duplicate-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const originalRegistration = id('registration-duplicate-old');
  const changedRegistration = id('registration-duplicate-new');
  const repairOrder = id('registration-duplicate-ro');
  const customer = await createCustomer('registration-duplicate-customer', ccmId);
  const physical = await prisma.$transaction((transaction) => findOrCreatePhysicalVehicle(transaction, vin));
  const vehicleBefore = await prisma.vehicle.create({
    data: {
      id: id('registration-duplicate-vehicle'),
      vin,
      physicalVehicleId: physical.id,
      registrationNumber: originalRegistration.toUpperCase(),
      customerId: customer.id,
      ccmId,
      model: 'Integration fixture',
    },
  });
  const previousVisit = await createWorkshopVisit(
    'registration-duplicate-original-visit',
    customer,
    vehicleBefore,
    ccmId,
    repairOrder,
    new Date('2026-01-15T00:00:00Z'),
  );
  await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5551000',
      vin,
      vehicleId: vehicleBefore.id,
      registrationNumber: originalRegistration.toUpperCase(),
      ccmId,
    },
  });
  const duplicate = await importCsv(csvRow(repairOrder, vin, changedRegistration), admin, ccmId);

  assert.equal(duplicate.statusCode, 201, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.batch.skippedRows, 1, JSON.stringify({ batch: duplicate.body.batch, errors: duplicate.body.errors }));
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicleId: vehicleBefore.physicalVehicleId } }), 1);
  assert.ok(await prisma.workshopVisit.findUnique({ where: { id: previousVisit.id } }));
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleBefore.id } })).registrationNumber, changedRegistration.toUpperCase());
  assert.equal(await prisma.importBatch.findUniqueOrThrow({ where: { id: duplicate.body.batch.id } }).then(({ rollbackSupported }) => rollbackSupported), true);

  await rollbackService.rollbackImportBatch(duplicate.body.batch.id, admin.id);
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleBefore.id } })).registrationNumber, originalRegistration.toUpperCase());
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicleId: vehicleBefore.physicalVehicleId } }), 1);
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: duplicate.body.batch.id } })).status, 'rolled_back');
});

test('registration already owned by another VIN in the CCM rejects the row without changing either vehicle', async () => {
  const ccmId = id('registration-conflict-team');
  const admin = await createUser('registration-conflict-admin', 'ADMIN');
  await createUser('registration-conflict-ccm', 'CCM', ccmId);
  const vinA = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const vinB = `2HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registrationA = id('registration-conflict-a');
  const registrationB = id('registration-conflict-b');
  await importCsv(csvRow(id('registration-conflict-ro-a'), vinA, registrationA), admin, ccmId);
  await importCsv(csvRow(id('registration-conflict-ro-b'), vinB, registrationB), admin, ccmId);

  const rejected = await importCsv(csvRow(id('registration-conflict-ro-c'), vinA, registrationB), admin, ccmId);
  assert.equal(rejected.statusCode, 201, JSON.stringify(rejected.body));
  assert.equal(rejected.body.batch.rejectedRows, 1);
  assert.equal(rejected.body.errors[0].errorCode, 'REGISTRATION_CONFLICT');
  assert.equal((await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin: vinA } })).registrationNumber, registrationA.toUpperCase());
  assert.equal((await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin: vinB } })).registrationNumber, registrationB.toUpperCase());
  assert.equal(await prisma.workshopVisit.count({
    where: { ccmId, physicalVehicle: { is: { vin: vinA } } },
  }), 1);
});

test('registration update for a shared VIN only changes the importing CCM vehicle and preserves both histories', async () => {
  const ccmA = id('registration-shared-a');
  const ccmB = id('registration-shared-b');
  const admin = await createUser('registration-shared-admin', 'ADMIN');
  await createUser('registration-shared-ccm-a', 'CCM', ccmA);
  await createUser('registration-shared-ccm-b', 'CCM', ccmB);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registrationA = id('registration-shared-old-a');
  const registrationB = id('registration-shared-old-b');
  const registrationBNext = id('registration-shared-new-b');
  const importA = await importCsv(csvRow(id('registration-shared-ro-a'), vin, registrationA), admin, ccmA);
  const importB = await importCsv(csvRow(id('registration-shared-ro-b'), vin, registrationB), admin, ccmB);
  const physical = await prisma.physicalVehicle.findUniqueOrThrow({ where: { vin } });
  const updateB = await importCsv(csvRow(id('registration-shared-ro-b-next'), vin, registrationBNext), admin, ccmB);

  assert.equal(importA.statusCode, 201);
  assert.equal(importB.statusCode, 201);
  assert.equal(updateB.statusCode, 201, JSON.stringify(updateB.body));
  assert.equal(await prisma.physicalVehicle.count({ where: { vin } }), 1);
  assert.equal((await prisma.vehicle.findFirstOrThrow({ where: { ccmId: ccmA, physicalVehicleId: physical.id } })).registrationNumber, registrationA.toUpperCase());
  assert.equal((await prisma.vehicle.findFirstOrThrow({ where: { ccmId: ccmB, physicalVehicleId: physical.id } })).registrationNumber, registrationBNext.toUpperCase());
  assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id, ccmId: ccmA } }), 1);
  assert.equal(await prisma.workshopVisit.count({ where: { physicalVehicleId: physical.id, ccmId: ccmB } }), 2);
});

test('permanent deletion rebases a later registration change and rollback restores a latest registration update', async () => {
  const ccmId = id('registration-rebase-team');
  const admin = await createUser('registration-rebase-admin', 'ADMIN');
  await createUser('registration-rebase-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const registrationA = id('registration-rebase-a');
  const registrationB = id('registration-rebase-b');
  const registrationC = id('registration-rebase-c');
  const importA = await importCsv(csvRow(id('registration-rebase-ro-a'), vin, registrationA), admin, ccmId);
  const importB = await importCsv(csvRow(id('registration-rebase-ro-b'), vin, registrationB), admin, ccmId);
  const importC = await importCsv(csvRow(id('registration-rebase-ro-c'), vin, registrationC), admin, ccmId);
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin } });
  const preview = await deletionService.previewPermanentImportDeletion(importB.body.batch.id);
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers));
  await deletionService.permanentlyDeleteImportBatch(importB.body.batch.id, admin.id, preview.confirmationToken);
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).registrationNumber, registrationC.toUpperCase());
  const laterRegistrationChange = await prisma.importChangeLog.findFirstOrThrow({
    where: { importBatchId: importC.body.batch.id, entityType: 'Vehicle', entityId: vehicle.id },
  });
  assert.equal(laterRegistrationChange.before.registrationNumber, registrationA.toUpperCase());
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicleId: vehicle.physicalVehicleId } }), 2);

  const rollbackCPreview = await deletionService.previewPermanentImportDeletion(importC.body.batch.id);
  assert.equal(rollbackCPreview.blockers.length, 0, JSON.stringify(rollbackCPreview.blockers));
  await deletionService.permanentlyDeleteImportBatch(importC.body.batch.id, admin.id, rollbackCPreview.confirmationToken);
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).registrationNumber, registrationA.toUpperCase());
  assert.equal(await prisma.workshopVisit.count({ where: { ccmId, physicalVehicleId: vehicle.physicalVehicleId } }), 1);
  assert.equal(importA.statusCode, 201);
});

test('monthly customer-data import updates a scoped VIN vehicle registration and records provenance', async () => {
  const ccmId = id('monthly-registration-team');
  const admin = await createUser('monthly-registration-admin', 'ADMIN');
  await createUser('monthly-registration-ccm', 'CCM', ccmId);
  const vin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const oldRegistration = id('monthly-registration-old');
  const newRegistration = id('monthly-registration-new');
  await importCsv(csvRow(id('monthly-registration-ro'), vin, oldRegistration), admin, ccmId);
  const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { ccmId, vin } });
  const content = [
    'Customer Name,Mobile,VIN,Registration Number,Make,Model',
    `Monthly Customer,5551099,${vin},${newRegistration},Hyundai,Test`,
  ].join('\n');

  const imported = await importMonthlyCsv(content, admin, ccmId, 2026, 11);
  assert.equal(imported.statusCode, 201, JSON.stringify(imported.body));
  const updated = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
  assert.equal(updated.registrationNumber, newRegistration.toUpperCase());
  const change = await prisma.importChangeLog.findFirstOrThrow({
    where: { importBatchId: imported.body.import.importBatchId, entityType: 'Vehicle', entityId: vehicle.id },
  });
  assert.equal(change.before.registrationNumber, oldRegistration.toUpperCase());
  assert.equal(change.after.registrationNumber, newRegistration.toUpperCase());
  assert.equal(await prisma.physicalVehicle.count({ where: { vin } }), 1);

  const missingRegistrationContent = [
    'Customer Name,Mobile,VIN,Registration Number,Make,Model',
    `Monthly Customer Follow-up,5551098,${vin},,Hyundai,Test`,
  ].join('\n');
  const missingRegistrationImport = await importMonthlyCsv(missingRegistrationContent, admin, ccmId, 2026, 12);
  assert.equal(missingRegistrationImport.statusCode, 201, JSON.stringify(missingRegistrationImport.body));
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).registrationNumber, newRegistration.toUpperCase());

  const conflictingVin = `2HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const conflictContent = [
    'Customer Name,Mobile,VIN,Registration Number,Make,Model',
    `Conflicting Monthly Customer,5551097,${conflictingVin},${newRegistration},Hyundai,Test`,
  ].join('\n');
  const conflictImport = await importMonthlyCsv(conflictContent, admin, ccmId, 2026, 10);
  assert.equal(conflictImport.statusCode, 201, JSON.stringify(conflictImport.body));
  assert.equal(conflictImport.body.import.rejectedRows, 1);
  assert.equal(conflictImport.body.import.rowErrors[0].errorCode, 'REGISTRATION_CONFLICT');
  assert.equal(await prisma.vehicle.count({ where: { ccmId, vin: conflictingVin } }), 0);
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
  assert.equal(deactivated.body.pendingCustomers, 2);
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
  assert.equal(transfer.statusCode, 200);
  assert.equal(currentCre.ccmId, newTeam);
  assert.equal(committedAllocations.length, allocation.statusCode === 201 ? 1 : 0);
  assert.ok(committedAllocations.every(({ ccmId, creId, assignmentNeedsReview }) => (
    ccmId === oldTeam && creId === null && assignmentNeedsReview
  )));
});

test('a CRE transfer completed before allocation blocks allocation under the old CCM', async () => {
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

test('a transfer after allocation leaves the vehicle in the source CCM pending queue', async () => {
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
  assert.equal(transferred.statusCode, 200);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: cre.id } })).ccmId, newTeam);
  assert.equal(await prisma.allocation.count({
    where: { vehicleId: vehicle.id, ccmId: oldTeam, creId: null, assignmentNeedsReview: true },
  }), 1);
  assert.equal(await prisma.vehicle.count({ where: { id: vehicle.id, ccmId: newTeam } }), 0);
});

test('multiple CRE transfers leave all source customers pending until the CCM explicitly allocates them', async () => {
  const sourceTeam = id('manual-transfer-source');
  const destinationTeam = id('manual-transfer-destination');
  const actor = await createUser('manual-transfer-admin', 'ADMIN');
  const sourceCcm = await createUser('manual-transfer-source-ccm', 'CCM', sourceTeam);
  await createUser('manual-transfer-destination-ccm', 'CCM', destinationTeam);
  const departingCres = [
    await createUser('manual-transfer-departing-a', 'CRE', sourceTeam),
    await createUser('manual-transfer-departing-b', 'CRE', sourceTeam),
    await createUser('manual-transfer-departing-c', 'CRE', sourceTeam),
  ];
  const remainingCres = [
    await createUser('manual-transfer-remaining-a', 'CRE', sourceTeam),
    await createUser('manual-transfer-remaining-b', 'CRE', sourceTeam),
  ];
  const fixtures = [];
  for (const [creIndex, cre] of departingCres.entries()) {
    for (let vehicleIndex = 0; vehicleIndex < 2; vehicleIndex += 1) {
      const customer = await createCustomer(`manual-transfer-customer-${creIndex}-${vehicleIndex}`, sourceTeam);
      const vehicle = await createVehicle(`manual-transfer-vehicle-${creIndex}-${vehicleIndex}`, customer, sourceTeam);
      const entry = await prisma.masterCallList.create({
        data: {
          customerName: customer.fullName,
          mobileNumber: `555${creIndex}0${vehicleIndex}`,
          vin: vehicle.vin,
          vehicleId: vehicle.id,
          ccmId: sourceTeam,
          ownerUserId: cre.id,
        },
      });
      const allocation = await prisma.allocation.create({
        data: { vehicleId: vehicle.id, creId: cre.id, ccmId: sourceTeam, serviceType: 'transfer-test' },
      });
      fixtures.push({ customer, vehicle, entry, allocation });
    }
  }

  for (const cre of departingCres) {
    const transferred = await transferCre(cre, actor, destinationTeam);
    assert.equal(transferred.statusCode, 200);
    assert.equal(transferred.body.user.ccmId, destinationTeam);
    assert.equal(transferred.body.pendingCustomers, 2);
  }

  const sourceEntries = await prisma.masterCallList.findMany({
    where: { ccmId: sourceTeam, id: { in: fixtures.map(({ entry }) => entry.id) } },
  });
  assert.ok(sourceEntries.every(({ ownerUserId, assignmentNeedsReview }) => ownerUserId === null && assignmentNeedsReview));
  const sourceAllocations = await prisma.allocation.findMany({
    where: { ccmId: sourceTeam, id: { in: fixtures.map(({ allocation }) => allocation.id) } },
  });
  assert.ok(sourceAllocations.every(({ creId, assignmentNeedsReview }) => creId === null && assignmentNeedsReview));
  assert.equal(await prisma.customer.count({ where: { ccmId: destinationTeam } }), 0);
  assert.equal(await prisma.vehicle.count({ where: { ccmId: destinationTeam } }), 0);
  assert.equal(await prisma.masterCallList.count({ where: { ccmId: destinationTeam } }), 0);
  assert.equal(await prisma.allocation.count({ where: { ccmId: destinationTeam } }), 0);
  const transferredCreCallList = await runController(recordsController.getCallList, {
    user: { id: departingCres[0].id, role: 'CRE', ccmId: destinationTeam },
    query: {},
  });
  assert.ok(transferredCreCallList.body.records.every(({ ccmId }) => ccmId === destinationTeam));
  assert.equal(transferredCreCallList.body.records.some(({ vin }) => fixtures.some(({ vehicle }) => vehicle.vin === vin)), false);

  const pending = await runController(allocationController.getPendingRedistribution, { user: sourceCcm });
  assert.equal(pending.body.pendingCustomers, 6);
  assert.equal(pending.body.activeCreCount, 2);
  const simultaneousAllocations = await Promise.all([
    runController(allocationController.allocatePendingRedistribution, { user: sourceCcm }),
    runController(allocationController.allocatePendingRedistribution, { user: sourceCcm }),
  ]);
  assert.ok(simultaneousAllocations.every(({ statusCode }) => statusCode === 200));
  assert.equal(simultaneousAllocations.reduce((total, { body }) => total + body.assignedCustomers, 0), 6);
  const finalEntries = await prisma.masterCallList.findMany({
    where: { ccmId: sourceTeam, id: { in: fixtures.map(({ entry }) => entry.id) } },
  });
  const finalOwners = finalEntries.map(({ ownerUserId }) => ownerUserId);
  assert.ok(finalOwners.every((ownerId) => remainingCres.some(({ id: creId }) => creId === ownerId)));
  assert.deepEqual([...new Set(finalOwners)].map((ownerId) => finalOwners.filter((id) => id === ownerId).length).sort(), [3, 3]);
  assert.ok(finalEntries.every(({ assignmentNeedsReview }) => !assignmentNeedsReview));
  assert.ok((await prisma.allocation.findMany({
    where: { ccmId: sourceTeam, id: { in: fixtures.map(({ allocation }) => allocation.id) } },
  })).every(({ creId, assignmentNeedsReview }) => remainingCres.some(({ id: remainingId }) => creId === remainingId) && !assignmentNeedsReview));
  assert.equal(await prisma.creAssignmentHistory.count({
    where: { ccmId: sourceTeam, previousCreId: { in: departingCres.map(({ id: creId }) => creId) }, newCreId: null, eventType: 'TRANSFERRED_PENDING_REDISTRIBUTION' },
  }), 12);
  assert.equal(await prisma.creAssignmentHistory.count({
    where: { ccmId: sourceTeam, eventType: 'MANUAL_REDISTRIBUTION', newCreId: { in: remainingCres.map(({ id: creId }) => creId) } },
  }), 12);
  const clearedQueue = await runController(allocationController.getPendingRedistribution, { user: sourceCcm });
  assert.equal(clearedQueue.body.pendingCustomers, 0);
  const repeatedAllocation = await runController(allocationController.allocatePendingRedistribution, { user: sourceCcm });
  assert.equal(repeatedAllocation.statusCode, 200);
  assert.equal(repeatedAllocation.body.assignedCustomers, 0);
});

test('manual allocation preserves non-pending allocations sharing queued VINs and processes pending allocations', async () => {
  const team = id('manual-shared-vin-team');
  const ccm = await createUser('manual-shared-vin-ccm', 'CCM', team);
  const creA = await createUser('manual-shared-vin-cre-a', 'CRE', team);
  const creB = await createUser('manual-shared-vin-cre-b', 'CRE', team);

  const sharedCustomer = await createCustomer('manual-shared-vin-customer', team);
  const sharedVehicle = await createVehicle('manual-shared-vin-vehicle', sharedCustomer, team);
  const sharedAllocation = await prisma.allocation.create({
    data: {
      vehicleId: sharedVehicle.id,
      creId: creA.id,
      ccmId: team,
      serviceType: 'existing-assignment',
      assignmentNeedsReview: false,
    },
  });
  const pendingEntry = await prisma.masterCallList.create({
    data: {
      customerName: sharedCustomer.fullName,
      mobileNumber: '5551080',
      vin: sharedVehicle.vin,
      vehicleId: sharedVehicle.id,
      ccmId: team,
      ownerUserId: null,
      assignmentNeedsReview: true,
    },
  });

  const pendingAllocationCustomer = await createCustomer('manual-pending-allocation-customer', team);
  const pendingAllocationVehicle = await createVehicle('manual-pending-allocation-vehicle', pendingAllocationCustomer, team);
  const pendingAllocation = await prisma.allocation.create({
    data: {
      vehicleId: pendingAllocationVehicle.id,
      creId: null,
      ccmId: team,
      serviceType: 'pending-assignment',
      assignmentNeedsReview: true,
    },
  });

  const unrelatedFixtures = [];
  for (const [label, owner] of [['a', creA], ['b', creB]]) {
    const customer = await createCustomer(`manual-unrelated-${label}-customer`, team);
    const vehicle = await createVehicle(`manual-unrelated-${label}-vehicle`, customer, team);
    const allocation = await prisma.allocation.create({
      data: {
        vehicleId: vehicle.id,
        creId: owner.id,
        ccmId: team,
        serviceType: 'unrelated-existing-assignment',
        assignmentNeedsReview: false,
      },
    });
    unrelatedFixtures.push({ allocation, creId: owner.id });
  }

  const result = await runController(allocationController.allocatePendingRedistribution, { user: ccm });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.assignedCustomers, 2);
  const assignedEntry = await prisma.masterCallList.findUniqueOrThrow({ where: { id: pendingEntry.id } });
  assert.equal(assignedEntry.ownerUserId, creB.id);
  assert.equal(assignedEntry.assignmentNeedsReview, false);

  const retainedSharedAllocation = await prisma.allocation.findUniqueOrThrow({ where: { id: sharedAllocation.id } });
  assert.equal(retainedSharedAllocation.creId, creA.id);
  assert.equal(retainedSharedAllocation.assignmentNeedsReview, false);

  const assignedPendingAllocation = await prisma.allocation.findUniqueOrThrow({ where: { id: pendingAllocation.id } });
  assert.equal(assignedPendingAllocation.creId, creA.id);
  assert.equal(assignedPendingAllocation.assignmentNeedsReview, false);

  for (const { allocation, creId } of unrelatedFixtures) {
    const unchanged = await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } });
    assert.equal(unchanged.creId, creId);
    assert.equal(unchanged.assignmentNeedsReview, false);
  }
});

test('CRE transfer leaves pending work when no source CRE remains and new CRE creation does not allocate it', async () => {
  const sourceTeam = id('manual-last-source');
  const destinationTeam = id('manual-last-destination');
  const actor = await createUser('manual-last-admin', 'ADMIN');
  const sourceCcm = await createUser('manual-last-source-ccm', 'CCM', sourceTeam);
  await createUser('manual-last-destination-ccm', 'CCM', destinationTeam);
  const departingCre = await createUser('manual-last-cre', 'CRE', sourceTeam);
  const customer = await createCustomer('manual-last-customer', sourceTeam);
  const vehicle = await createVehicle('manual-last-vehicle', customer, sourceTeam);
  const entry = await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5551050',
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      ccmId: sourceTeam,
      ownerUserId: departingCre.id,
    },
  });
  await transferCre(departingCre, actor, destinationTeam);

  const noCrewQueue = await runController(allocationController.getPendingRedistribution, { user: sourceCcm });
  assert.equal(noCrewQueue.body.pendingCustomers, 1);
  assert.equal(noCrewQueue.body.activeCreCount, 0);
  const blocked = await runController(allocationController.allocatePendingRedistribution, { user: sourceCcm });
  assert.equal(blocked.statusCode, 409);

  const created = await runController(userController.createUser, {
    user: actor,
    body: {
      name: 'Manual Queue Replacement',
      username: `${suffix.slice(0, 12)}-replacement`,
      password: 'integration-password',
      role: 'CRE',
      ccmId: sourceTeam,
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).ownerUserId, null);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).assignmentNeedsReview, true);

  const allocated = await runController(allocationController.allocatePendingRedistribution, { user: sourceCcm });
  assert.equal(allocated.statusCode, 200);
  assert.equal(allocated.body.assignedCustomers, 1);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).ownerUserId, created.body.user.id);
});

test('monthly import allocation remains automatic and does not consume CRE-transfer pending work', async () => {
  const sourceTeam = id('monthly-pending-source');
  const destinationTeam = id('monthly-pending-destination');
  const admin = await createUser('monthly-pending-admin', 'ADMIN');
  await createUser('monthly-pending-source-ccm', 'CCM', sourceTeam);
  await createUser('monthly-pending-destination-ccm', 'CCM', destinationTeam);
  const departingCre = await createUser('monthly-pending-departing', 'CRE', sourceTeam);
  const remainingCre = await createUser('monthly-pending-survivor', 'CRE', sourceTeam);
  const pendingCustomer = await createCustomer('monthly-pending-customer', sourceTeam);
  const pendingVehicle = await createVehicle('monthly-pending-vehicle', pendingCustomer, sourceTeam);
  const pendingEntry = await prisma.masterCallList.create({
    data: {
      customerName: pendingCustomer.fullName,
      mobileNumber: '5551060',
      vin: pendingVehicle.vin,
      vehicleId: pendingVehicle.id,
      ccmId: sourceTeam,
      ownerUserId: departingCre.id,
    },
  });
  const pendingAllocation = await prisma.allocation.create({
    data: { vehicleId: pendingVehicle.id, creId: departingCre.id, ccmId: sourceTeam, serviceType: 'pending-service' },
  });
  await transferCre(departingCre, admin, destinationTeam);

  const monthlyVin = `1HG${randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const imported = await importMonthlyCsv([
    'Customer Name,Mobile,VIN,Registration Number,Make,Model',
    `Monthly Import Customer,5551061,${monthlyVin},${id('monthly-pending-registration')},Hyundai,Test`,
  ].join('\n'), admin, sourceTeam, 2026, 10);
  assert.equal(imported.statusCode, 201, JSON.stringify(imported.body));
  const importedEntry = await prisma.masterCallList.findFirstOrThrow({ where: { vin: monthlyVin, ccmId: sourceTeam } });
  assert.equal(importedEntry.ownerUserId, remainingCre.id);
  assert.equal(importedEntry.assignmentNeedsReview, false);
  const stillPendingEntry = await prisma.masterCallList.findUniqueOrThrow({ where: { id: pendingEntry.id } });
  const stillPendingAllocation = await prisma.allocation.findUniqueOrThrow({ where: { id: pendingAllocation.id } });
  assert.equal(stillPendingEntry.ownerUserId, null);
  assert.equal(stillPendingEntry.assignmentNeedsReview, true);
  assert.equal(stillPendingAllocation.creId, null);
  assert.equal(stillPendingAllocation.assignmentNeedsReview, true);
  assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: pendingVehicle.id } })).ccmId, sourceTeam);
  assert.equal(await prisma.customer.count({ where: { ccmId: destinationTeam } }), 0);
});

test('failed pending allocation rolls back completely and the CCM can retry', async () => {
  const sourceTeam = id('manual-retry-source');
  const destinationTeam = id('manual-retry-destination');
  const actor = await createUser('manual-retry-admin', 'ADMIN');
  const sourceCcm = await createUser('manual-retry-source-ccm', 'CCM', sourceTeam);
  await createUser('manual-retry-destination-ccm', 'CCM', destinationTeam);
  const departingCre = await createUser('manual-retry-departing', 'CRE', sourceTeam);
  const survivor = await createUser('manual-retry-survivor', 'CRE', sourceTeam);
  const customer = await createCustomer('manual-retry-customer', sourceTeam);
  const vehicle = await createVehicle('manual-retry-vehicle', customer, sourceTeam);
  const entry = await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5551070',
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      ccmId: sourceTeam,
      ownerUserId: departingCre.id,
    },
  });
  const allocation = await prisma.allocation.create({
    data: { vehicleId: vehicle.id, creId: departingCre.id, ccmId: sourceTeam, serviceType: 'retry-service' },
  });
  await transferCre(departingCre, actor, destinationTeam);
  const triggerName = `fail_manual_redistribution_${suffix}`;
  const functionName = `raise_manual_redistribution_${suffix}`;
  try {
    await verificationClient.query(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."eventType" = 'MANUAL_REDISTRIBUTION' THEN
          RAISE EXCEPTION 'injected manual redistribution failure';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await verificationClient.query(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "cre_assignment_history"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    await assert.rejects(
      () => runController(allocationController.allocatePendingRedistribution, { user: sourceCcm }),
      /injected manual redistribution failure/,
    );
    const rolledBackEntry = await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } });
    const rolledBackAllocation = await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } });
    assert.equal(rolledBackEntry.ownerUserId, null);
    assert.equal(rolledBackEntry.assignmentNeedsReview, true);
    assert.equal(rolledBackAllocation.creId, null);
    assert.equal(rolledBackAllocation.assignmentNeedsReview, true);
    assert.equal(await prisma.creAssignmentHistory.count({
      where: { masterCallListId: entry.id, eventType: 'MANUAL_REDISTRIBUTION' },
    }), 0);
  } finally {
    await verificationClient.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON "cre_assignment_history"`).catch(() => {});
    await verificationClient.query(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {});
  }
  const retried = await runController(allocationController.allocatePendingRedistribution, { user: sourceCcm });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.assignedCustomers, 1);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).ownerUserId, survivor.id);
  assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } })).creId, survivor.id);
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

test('permanently deleting a CRE leaves work pending and retains historical identity and activity', async () => {
  const team = id('delete-team');
  const otherTeam = id('delete-other-team');
  const actor = await createUser('delete-admin', 'ADMIN');
  const ccm = await createUser('delete-ccm', 'CCM', team);
  await createUser('delete-other-ccm', 'CCM', otherTeam);
  const departingCre = await createUser('delete-departing-cre', 'CRE', team);
  const remainingCres = [
    await createUser('delete-remaining-cre-a', 'CRE', team),
    await createUser('delete-remaining-cre-b', 'CRE', team),
  ];
  const otherCre = await createUser('delete-other-cre', 'CRE', otherTeam);

  const fixtures = [];
  for (let index = 0; index < 4; index += 1) {
    const customer = await createCustomer(`delete-customer-${index}`, team);
    const vehicle = await createVehicle(`delete-vehicle-${index}`, customer, team);
    const entry = await prisma.masterCallList.create({
      data: {
        customerName: customer.fullName,
        mobileNumber: '5550100',
        vin: vehicle.vin,
        vehicleId: vehicle.id,
        ccmId: team,
        ownerUserId: departingCre.id,
      },
    });
    const allocation = await prisma.allocation.create({
      data: { vehicleId: vehicle.id, creId: departingCre.id, ccmId: team, serviceType: 'service' },
    });
    fixtures.push({ customer, vehicle, entry, allocation });
  }
  const otherCustomer = await createCustomer('delete-other-customer', otherTeam);
  const otherVehicle = await createVehicle('delete-other-vehicle', otherCustomer, otherTeam);
  const otherAllocation = await prisma.allocation.create({
    data: { vehicleId: otherVehicle.id, creId: otherCre.id, ccmId: otherTeam, serviceType: 'other-team' },
  });

  const historicalCustomer = fixtures[0].customer;
  const historicalVehicle = fixtures[0].vehicle;
  const workshopVisit = await createWorkshopVisit(
    'delete-preserved-visit',
    historicalCustomer,
    historicalVehicle,
    team,
    id('delete-preserved-ro'),
    new Date('2025-11-01T00:00:00Z'),
  );
  const call = await prisma.callLog.create({
    data: {
      customerId: historicalCustomer.id,
      vehicleId: historicalVehicle.id,
      ccmId: team,
      assignedToId: departingCre.id,
      createdById: departingCre.id,
      outcome: 'CONTACTED',
    },
  });
  const appointment = await prisma.appointment.create({
    data: {
      customerId: historicalCustomer.id,
      vehicleId: historicalVehicle.id,
      customerName: historicalCustomer.fullName,
      vehicleName: historicalVehicle.model || 'Integration vehicle',
      scheduledAt: new Date('2026-12-01T10:00:00Z'),
      ccmId: team,
      assigneeId: departingCre.id,
      createdById: departingCre.id,
    },
  });
  const followUp = await prisma.followUp.create({
    data: {
      customerId: historicalCustomer.id,
      vehicleId: historicalVehicle.id,
      ccmId: team,
      creId: departingCre.id,
      followUpAt: new Date('2026-12-02T10:00:00Z'),
      category: 'SERVICE',
    },
  });
  await prisma.creAssignmentHistory.create({
    data: {
      vehicleId: historicalVehicle.id,
      masterCallListId: fixtures[0].entry.id,
      ccmId: team,
      previousCreId: departingCre.id,
      actorUserId: departingCre.id,
      eventType: 'REASSIGNED',
    },
  });
  await prisma.auditLog.create({
    data: {
      userId: departingCre.id,
      entityType: 'User',
      entityId: departingCre.id,
      action: 'HISTORICAL_CRE_ACTION',
    },
  });
  const target = await prisma.cRETarget.create({
    data: { creId: departingCre.id, month: '2026-11', targetCalls: 100, targetAppoints: 20 },
  });
  const monthlyDataset = await prisma.monthlyCustomerDataset.create({
    data: { ccmUserId: departingCre.id, ccmId: team, year: 2026, month: 11 },
  });

  const result = await deleteCre(departingCre, actor);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.redistribution, {
    affectedCustomers: 4,
    redistributedCustomers: 0,
    unassignedCustomers: 4,
    pendingCustomers: 4,
    remainingCreCount: 2,
  });
  assert.equal(await prisma.user.findUnique({ where: { id: departingCre.id } }), null);
  assert.deepEqual(await prisma.deletedUserIdentity.findUniqueOrThrow({ where: { id: departingCre.id } }).then(({ name, role, ccmId }) => ({ name, role, ccmId })), {
    name: departingCre.name,
    role: 'CRE',
    ccmId: team,
  });
  const archivedIdentityEvent = await prisma.creAssignmentHistory.create({
    data: {
      vehicleId: historicalVehicle.id,
      masterCallListId: fixtures[0].entry.id,
      ccmId: team,
      previousCreId: departingCre.id,
      newCreId: remainingCres[0].id,
      actorUserId: actor.id,
      eventType: 'REASSIGNED',
    },
  });
  assert.equal(archivedIdentityEvent.previousCreId, departingCre.id);
  await assert.rejects(() => prisma.creAssignmentHistory.create({
    data: {
      vehicleId: historicalVehicle.id,
      masterCallListId: fixtures[0].entry.id,
      ccmId: team,
      previousCreId: id('unknown-deleted-user'),
      eventType: 'REASSIGNED',
    },
  }), /CRE assignment history references an unknown user identity/);

  const reassignedEntries = await prisma.masterCallList.findMany({
    where: { ccmId: team, id: { in: fixtures.map(({ entry }) => entry.id) } },
    select: { ownerUserId: true, assignmentNeedsReview: true },
  });
  assert.equal(reassignedEntries.length, 4);
  assert.ok(reassignedEntries.every(({ ownerUserId, assignmentNeedsReview }) => ownerUserId === null && assignmentNeedsReview));
  assert.equal(await prisma.allocation.count({
    where: { ccmId: team, creId: null, assignmentNeedsReview: true, status: 'assigned' },
  }), 4);
  assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: otherAllocation.id } })).creId, otherCre.id);

  const retainedCall = await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } });
  assert.equal(retainedCall.createdById, null);
  assert.equal(retainedCall.assignedToId, null);
  assert.equal(retainedCall.createdByIdSnapshot, departingCre.id);
  assert.equal(retainedCall.assignedToIdSnapshot, departingCre.id);
  assert.equal(retainedCall.createdByNameSnapshot, departingCre.name);
  assert.equal(retainedCall.assignedToUsernameSnapshot, departingCre.username);
  const callHistory = await runController(callWorkflowController.listCallLogs, {
    user: ccm,
    params: {},
    query: { customerId: historicalCustomer.id },
  });
  assert.equal(callHistory.body.callLogs[0].creator.name, departingCre.name);
  assert.equal(callHistory.body.callLogs[0].assignee.name, departingCre.name);
  const retainedAppointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
  assert.equal(retainedAppointment.assigneeIdSnapshot, departingCre.id);
  assert.equal(retainedAppointment.createdByIdSnapshot, departingCre.id);
  assert.equal(retainedAppointment.assigneeNameSnapshot, departingCre.name);
  const appointmentHistory = await runController(recordsController.getAppointments, { user: ccm });
  assert.equal(appointmentHistory.body.appointments.find(({ id: appointmentId }) => appointmentId === appointment.id).assigneeName, departingCre.name);
  const retainedFollowUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
  assert.equal(retainedFollowUp.creIdSnapshot, departingCre.id);
  assert.equal(retainedFollowUp.creNameSnapshot, departingCre.name);
  const followUpHistory = await runController(callWorkflowController.listFollowUps, {
    user: ccm,
    params: {},
    query: { search: historicalCustomer.fullName },
  });
  assert.equal(followUpHistory.body.followUps.find(({ id: followUpId }) => followUpId === followUp.id).cre.name, departingCre.name);
  const historicalEvent = await prisma.creAssignmentHistory.findFirst({
    where: {
      masterCallListId: fixtures[0].entry.id,
      eventType: 'REASSIGNED',
      previousCreId: departingCre.id,
      actorUserId: departingCre.id,
    },
  });
  assert.equal(historicalEvent.previousCreId, departingCre.id);
  assert.equal(historicalEvent.actorUserId, departingCre.id);
  const historicalAudit = await prisma.auditLog.findFirst({
    where: { action: 'HISTORICAL_CRE_ACTION', entityId: departingCre.id },
  });
  assert.equal(historicalAudit.userId, null);
  assert.equal(historicalAudit.userIdSnapshot, departingCre.id);
  const retainedTarget = await prisma.cRETarget.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(retainedTarget.creId, departingCre.id);
  assert.equal(retainedTarget.creNameSnapshot, departingCre.name);
  const retainedDataset = await prisma.monthlyCustomerDataset.findUniqueOrThrow({ where: { id: monthlyDataset.id } });
  assert.equal(retainedDataset.ccmUserIdSnapshot, departingCre.id);
  assert.equal(retainedDataset.ccmUserNameSnapshot, departingCre.name);
  assert.equal(await prisma.customer.count({ where: { ccmId: team } }), 4);
  assert.equal(await prisma.vehicle.count({ where: { ccmId: team } }), 4);
  assert.equal(await prisma.physicalVehicle.count({ where: { id: { in: fixtures.map(({ vehicle }) => vehicle.physicalVehicleId) } } }), 4);
  assert.equal(await prisma.workshopVisit.count({ where: { id: workshopVisit.id } }), 1);
});

test('permanently deleting a CRE leaves its customers pending even when another CRE remains', async () => {
  const team = id('delete-one-remaining-team');
  const actor = await createUser('delete-one-remaining-admin', 'ADMIN');
  await createUser('delete-one-remaining-ccm', 'CCM', team);
  const departingCre = await createUser('delete-one-remaining-departing', 'CRE', team);
  const remainingCre = await createUser('delete-one-remaining-survivor', 'CRE', team);
  const customer = await createCustomer('delete-one-remaining-customer', team);
  const vehicle = await createVehicle('delete-one-remaining-vehicle', customer, team);
  const entry = await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5550110',
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      ccmId: team,
      ownerUserId: departingCre.id,
    },
  });

  const result = await deleteCre(departingCre, actor);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.redistribution, {
    affectedCustomers: 1,
    redistributedCustomers: 0,
    unassignedCustomers: 1,
    pendingCustomers: 1,
    remainingCreCount: 1,
  });
  const pending = await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(pending.ownerUserId, null);
  assert.equal(pending.assignmentNeedsReview, true);
});

test('concurrent permanent deletion requests redistribute a CRE workload only once', async () => {
  const team = id('delete-concurrent-team');
  const actor = await createUser('delete-concurrent-admin', 'ADMIN');
  await createUser('delete-concurrent-ccm', 'CCM', team);
  const departingCre = await createUser('delete-concurrent-departing', 'CRE', team);
  const remainingCre = await createUser('delete-concurrent-survivor', 'CRE', team);
  const customer = await createCustomer('delete-concurrent-customer', team);
  const vehicle = await createVehicle('delete-concurrent-vehicle', customer, team);
  const entry = await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5550120',
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      ccmId: team,
      ownerUserId: departingCre.id,
    },
  });

  const results = await Promise.all([deleteCre(departingCre, actor), deleteCre(departingCre, actor)]);

  assert.equal(results.filter(({ statusCode }) => statusCode === 200).length, 1);
  assert.equal(results.filter(({ statusCode }) => [404, 409].includes(statusCode)).length, 1);
  const pending = await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(pending.ownerUserId, null);
  assert.equal(pending.assignmentNeedsReview, true);
  assert.equal(await prisma.deletedUserIdentity.count({ where: { id: departingCre.id } }), 1);
  assert.equal(await prisma.creAssignmentHistory.count({
    where: { masterCallListId: entry.id, previousCreId: departingCre.id, newCreId: null },
  }), 1);
});

test('deleting the last CRE leaves work in the CCM pool for later manual assignment', async () => {
  const team = id('delete-last-team');
  const actor = await createUser('delete-last-admin', 'ADMIN');
  const ccm = await createUser('delete-last-ccm', 'CCM', team);
  const departingCre = await createUser('delete-last-cre', 'CRE', team);
  const customer = await createCustomer('delete-last-customer', team);
  const vehicle = await createVehicle('delete-last-vehicle', customer, team);
  const entry = await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5550200',
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      ccmId: team,
      ownerUserId: departingCre.id,
    },
  });
  const allocation = await prisma.allocation.create({
    data: { vehicleId: vehicle.id, creId: departingCre.id, ccmId: team, serviceType: 'service' },
  });

  const deleted = await deleteCre(departingCre, actor);
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.body.redistribution, {
    affectedCustomers: 1,
    redistributedCustomers: 0,
    unassignedCustomers: 1,
    pendingCustomers: 1,
    remainingCreCount: 0,
  });
  const pendingEntry = await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } });
  assert.equal(pendingEntry.ownerUserId, null);
  assert.equal(pendingEntry.assignmentNeedsReview, true);
  assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } })).creId, null);

  const createdCre = await runController(userController.createUser, {
    user: actor,
    body: {
      name: 'Later replacement CRE',
      username: `${suffix.slice(0, 12)}-delete-last-cre`,
      password: 'integration-password',
      role: 'CRE',
      ccmId: team,
    },
  });
  assert.equal(createdCre.statusCode, 201);
  const newCre = createdCre.body.user;
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).ownerUserId, null);
  const pendingBefore = await runController(allocationController.getPendingRedistribution, { user: ccm });
  assert.equal(pendingBefore.body.pendingCustomers, 1);
  assert.equal(pendingBefore.body.activeCreCount, 1);
  const manualAssignment = await runController(allocationController.allocatePendingRedistribution, {
    user: ccm,
  });
  assert.equal(manualAssignment.statusCode, 200);
  assert.equal(manualAssignment.body.assignedCustomers, 1);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).ownerUserId, newCre.id);
  assert.equal((await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } })).creId, newCre.id);
});

test('permanent CRE deletion rejects cross-CCM assignments without modifying either team', async () => {
  const team = id('delete-cross-team');
  const otherTeam = id('delete-cross-other');
  const actor = await createUser('delete-cross-admin', 'ADMIN');
  await createUser('delete-cross-ccm', 'CCM', team);
  await createUser('delete-cross-other-ccm', 'CCM', otherTeam);
  const departingCre = await createUser('delete-cross-cre', 'CRE', team);
  const otherCustomer = await createCustomer('delete-cross-customer', otherTeam);
  const otherVehicle = await createVehicle('delete-cross-vehicle', otherCustomer, otherTeam);
  const foreignEntry = await prisma.masterCallList.create({
    data: {
      customerName: otherCustomer.fullName,
      mobileNumber: '5550300',
      vin: otherVehicle.vin,
      vehicleId: otherVehicle.id,
      ccmId: otherTeam,
      ownerUserId: departingCre.id,
    },
  });

  const result = await deleteCre(departingCre, actor);

  assert.equal(result.statusCode, 409);
  assert.equal(await prisma.user.findUnique({ where: { id: departingCre.id } }).then(Boolean), true);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: foreignEntry.id } })).ownerUserId, departingCre.id);
  assert.equal(await prisma.deletedUserIdentity.count({ where: { id: departingCre.id } }), 0);
});

test('a failed account deletion rolls back reassignment, history, and identity archival', async () => {
  const team = id('delete-rollback-team');
  const actor = await createUser('delete-rollback-admin', 'ADMIN');
  await createUser('delete-rollback-ccm', 'CCM', team);
  const departingCre = await createUser('delete-rollback-cre', 'CRE', team);
  await createUser('delete-rollback-remaining-cre', 'CRE', team);
  const customer = await createCustomer('delete-rollback-customer', team);
  const vehicle = await createVehicle('delete-rollback-vehicle', customer, team);
  const entry = await prisma.masterCallList.create({
    data: {
      customerName: customer.fullName,
      mobileNumber: '5550400',
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      ccmId: team,
      ownerUserId: departingCre.id,
    },
  });

  const identifier = `p3_delete_fail_${suffix}`;
  const triggerName = `${identifier}_trigger`;
  const functionName = `${identifier}_function`;
  const escapedUserId = departingCre.id.replaceAll("'", "''");
  const testClient = new PgClient({ connectionString: databaseUrl });
  await testClient.connect();
  try {
    await testClient.query(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF OLD."id" = '${escapedUserId}' THEN
          RAISE EXCEPTION 'injected permanent deletion failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await testClient.query(`
      CREATE TRIGGER "${triggerName}"
      BEFORE DELETE ON "users"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    await assert.rejects(() => deleteCre(departingCre, actor), /injected permanent deletion failure/);
  } finally {
    await testClient.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON "users"`).catch(() => {});
    await testClient.query(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {});
    await testClient.end();
  }

  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: departingCre.id } })).id, departingCre.id);
  assert.equal((await prisma.masterCallList.findUniqueOrThrow({ where: { id: entry.id } })).ownerUserId, departingCre.id);
  assert.equal(await prisma.creAssignmentHistory.count({ where: { vehicleId: vehicle.id } }), 0);
  assert.equal(await prisma.deletedUserIdentity.count({ where: { id: departingCre.id } }), 0);
});

}
