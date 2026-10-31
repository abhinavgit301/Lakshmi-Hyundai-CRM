import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configureTestDatabaseUrl } from './testDatabaseConfig.js';

configureTestDatabaseUrl(process.env.TEST_DATABASE_URL);

const [{ prisma }, { previewPermanentImportDeletion, permanentlyDeleteImportBatch }, { recordImportChange, importSnapshot }] = await Promise.all([
  import('../../src/config/prisma.js'),
  import('../../src/services/permanentImportDeletionService.js'),
  import('../../src/utils/importChangeLog.js'),
]);

const prefix = `it_${randomUUID().replaceAll('-', '')}`;
const fixture = {
  userIds: [],
  batchIds: [],
  rowIds: [],
  customerIds: [],
  vehicleIds: [],
  visitIds: [],
  callIds: [],
  errorIds: [],
};

function next(label) {
  return `${prefix}_${label}_${randomUUID().replaceAll('-', '')}`;
}

function repairOrderIdentity(repairOrderNo) {
  return {
    repairOrderNo,
    normalizedRepairOrderNo: String(repairOrderNo).trim().replace(/\s+/g, ' ').toUpperCase(),
  };
}

async function createAdmin() {
  const user = await prisma.user.create({
    data: {
      id: next('admin'),
      name: 'Permanent deletion integration admin',
      password: 'integration-only-placeholder',
      role: 'ADMIN',
    },
  });
  fixture.userIds.push(user.id);
  return user;
}

async function createBatch(label, createdAt, changeCount, rowOutcome = 'created') {
  const id = next(label);
  const rowProgressId = next(`${label}-row`);
  const batch = await prisma.importBatch.create({
    data: {
      id,
      fileName: `${label}.csv`,
      status: 'completed',
      rollbackSupported: true,
      statsComplete: true,
      affectedCountsComplete: true,
      totalRows: 1,
      processedRows: 1,
      createdRows: rowOutcome === 'created' ? 1 : 0,
      appendedRows: rowOutcome === 'appended' ? 1 : 0,
      allocationEvidenceState: 'not_started',
      allocationChangeCount: 0,
      createdAt,
      rowProgress: {
        create: {
          id: rowProgressId,
          rowNumber: 2,
          status: 'completed',
          outcome: rowOutcome,
          mutationState: 'complete',
          loggedChangeCount: changeCount,
        },
      },
    },
  });
  fixture.batchIds.push(id);
  fixture.rowIds.push(rowProgressId);
  return { batch, rowProgressId };
}

async function addChanges(transaction, batchId, rowProgressId, ccmId, changes) {
  for (const [index, [entityType, entity, operation, before, after]] of changes.entries()) {
    await recordImportChange(transaction, {
      importBatchId: batchId,
      rowProgressId,
      sequence: index + 1,
      entityType,
      entityId: entity.id,
      ccmId,
      operation,
      before: importSnapshot(before),
      after: importSnapshot(after),
    });
  }
}

async function createImportedCustomerVehicleVisit(batch, rowProgressId, ccmId) {
  return prisma.$transaction(async (transaction) => {
    const customer = await transaction.customer.create({
      data: {
        id: next('customer'),
        customerCode: next('customer-code'),
        fullName: 'Import-created customer',
        mobileNumber: next('mobile'),
        ccmId,
      },
    });
    const vehicle = await transaction.vehicle.create({
      data: {
        id: next('vehicle'),
        vin: next('vin'),
        registrationNumber: next('registration'),
        customerId: customer.id,
        ccmId,
      },
    });
    const visit = await transaction.workshopVisit.create({
      data: {
        id: next('visit'),
        ...repairOrderIdentity(next('repair-order')),
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
        importedDetails: { source: 'integration-test', tags: ['created', null] },
      },
    });
    fixture.customerIds.push(customer.id);
    fixture.vehicleIds.push(vehicle.id);
    fixture.visitIds.push(visit.id);
    await addChanges(transaction, batch.id, rowProgressId, ccmId, [
      ['Customer', customer, 'CREATE', {}, customer],
      ['Vehicle', vehicle, 'CREATE', {}, vehicle],
      ['WorkshopVisit', visit, 'CREATE', {}, visit],
    ]);
    return { customer, vehicle, visit };
  });
}

async function cleanupFixture() {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: fixture.batchIds } },
        { userId: { in: fixture.userIds } },
      ],
    },
  });
  await prisma.importRowError.deleteMany({ where: { id: { in: fixture.errorIds } } });
  await prisma.callLog.deleteMany({
    where: { OR: [{ id: { in: fixture.callIds } }, { customerId: { in: fixture.customerIds } }, { vehicleId: { in: fixture.vehicleIds } }] },
  });
  await prisma.followUp.deleteMany({
    where: { OR: [{ customerId: { in: fixture.customerIds } }, { vehicleId: { in: fixture.vehicleIds } }] },
  });
  await prisma.appointment.deleteMany({
    where: { OR: [{ customerId: { in: fixture.customerIds } }, { vehicleId: { in: fixture.vehicleIds } }] },
  });
  await prisma.allocation.deleteMany({ where: { vehicleId: { in: fixture.vehicleIds } } });
  await prisma.vehicleOwnershipHistory.deleteMany({ where: { vehicleId: { in: fixture.vehicleIds } } });
  await prisma.monthlyCustomerDataEntry.deleteMany({
    where: { OR: [{ customerId: { in: fixture.customerIds } }, { vehicleId: { in: fixture.vehicleIds } }] },
  });
  await prisma.workshopVisit.deleteMany({ where: { id: { in: fixture.visitIds } } });
  await prisma.masterCallList.deleteMany({ where: { vin: { in: fixture.vehicleIds.map((id) => `${id}-vin`) } } });
  await prisma.freeServiceMilestone.deleteMany({ where: { vehicleId: { in: fixture.vehicleIds } } });
  await prisma.vINConflictReview.deleteMany({ where: { vin: { in: fixture.vehicleIds.map((id) => `${id}-vin`) } } });
  await prisma.importBatch.deleteMany({ where: { id: { in: fixture.batchIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: fixture.vehicleIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: fixture.customerIds } } });
  await prisma.user.deleteMany({ where: { id: { in: fixture.userIds } } });
  for (const key of Object.keys(fixture)) fixture[key].length = 0;
}

afterEach(cleanupFixture);
after(async () => { await prisma.$disconnect(); });

test('PostgreSQL deletes only target-created business records and retains import history and audit evidence', async () => {
  const admin = await createAdmin();
  const { batch, rowProgressId } = await createBatch('target-created', new Date('2020-01-01T00:00:00.000Z'), 3);
  const ccmId = next('ccm');
  const created = await createImportedCustomerVehicleVisit(batch, rowProgressId, ccmId);
  await prisma.importRowError.create({
    data: {
      id: next('row-error'),
      importBatchId: batch.id,
      rowNumber: 3,
      errorCode: 'TEST_RETAINED',
      errorMessage: 'Integration history retention check',
    },
  }).then(({ id }) => fixture.errorIds.push(id));

  const preview = await previewPermanentImportDeletion(batch.id);
  assert.equal(preview.willDelete.length, 3);
  assert.equal(preview.blockers.length, 0);
  assert.ok(preview.confirmationToken);
  const result = await permanentlyDeleteImportBatch(batch.id, admin.id, preview.confirmationToken);

  const [customer, vehicle, visit, retainedBatch, changes, errors, audits] = await Promise.all([
    prisma.customer.findUnique({ where: { id: created.customer.id } }),
    prisma.vehicle.findUnique({ where: { id: created.vehicle.id } }),
    prisma.workshopVisit.findUnique({ where: { id: created.visit.id } }),
    prisma.importBatch.findUnique({ where: { id: batch.id } }),
    prisma.importChangeLog.findMany({ where: { importBatchId: batch.id } }),
    prisma.importRowError.findMany({ where: { importBatchId: batch.id } }),
    prisma.auditLog.findMany({ where: { entityType: 'ImportBatch', entityId: batch.id } }),
  ]);
  assert.equal(result.status, 'permanently_deleted');
  assert.equal(customer, null);
  assert.equal(vehicle, null);
  assert.equal(visit, null);
  assert.equal(retainedBatch.status, 'permanently_deleted');
  assert.equal(changes.length, 3);
  assert.ok(changes.every(({ rollbackStatus }) => rollbackStatus === 'pending'));
  assert.equal(errors.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED');

  const replacementCustomer = await prisma.customer.create({
    data: { id: next('replacement-customer'), customerCode: next('replacement-code'), fullName: 'Replacement', mobileNumber: '9000000001', ccmId },
  });
  fixture.customerIds.push(replacementCustomer.id);
  const replacementVehicle = await prisma.vehicle.create({
    data: {
      id: next('replacement-vehicle'),
      vin: created.vehicle.vin,
      customerId: replacementCustomer.id,
      ccmId,
    },
  });
  fixture.vehicleIds.push(replacementVehicle.id);
  const replacementVisit = await prisma.workshopVisit.create({
    data: {
      id: next('replacement-visit'),
      ...repairOrderIdentity(created.visit.repairOrderNo),
      customerId: replacementCustomer.id,
      vehicleId: replacementVehicle.id,
      ccmId,
    },
  });
  fixture.visitIds.push(replacementVisit.id);
});

test('PostgreSQL preserves pre-existing customer history and unrelated later vehicle fields', async () => {
  const admin = await createAdmin();
  const targetDate = new Date('2020-02-01T00:00:00.000Z');
  const laterDate = new Date('2021-02-01T00:00:00.000Z');
  const ccmId = next('ccm');
  const customer = await prisma.customer.create({
    data: { id: next('existing-customer'), customerCode: next('existing-code'), fullName: 'Pre-existing', mobileNumber: next('mobile'), ccmId },
  });
  fixture.customerIds.push(customer.id);
  const vehicle = await prisma.vehicle.create({
    data: {
      id: next('existing-vehicle'),
      vin: next('existing-vin'),
      customerId: customer.id,
      ccmId,
      saleDate: new Date('2020-01-01T00:00:00.000Z'),
      model: 'i20',
    },
  });
  fixture.vehicleIds.push(vehicle.id);
  const unrelatedVisit = await prisma.workshopVisit.create({
    data: {
      id: next('unrelated-visit'),
      ...repairOrderIdentity(next('unrelated-ro')),
      customerId: customer.id,
      vehicleId: vehicle.id,
      ccmId,
    },
  });
  fixture.visitIds.push(unrelatedVisit.id);
  const target = await createBatch('target-update', targetDate, 2);
  const targetChange = await prisma.$transaction(async (transaction) => {
    const visit = await transaction.workshopVisit.create({
      data: {
        id: next('target-visit'),
        ...repairOrderIdentity(next('target-ro')),
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
      },
    });
    fixture.visitIds.push(visit.id);
    const updatedVehicle = await transaction.vehicle.update({
      where: { id: vehicle.id },
      data: { saleDate: new Date('2020-03-01T00:00:00.000Z') },
    });
    await addChanges(transaction, target.batch.id, target.rowProgressId, ccmId, [
      ['WorkshopVisit', visit, 'CREATE', {}, visit],
      ['Vehicle', updatedVehicle, 'UPDATE', {
        saleDate: vehicle.saleDate,
        updatedAt: vehicle.updatedAt,
      }, {
        saleDate: updatedVehicle.saleDate,
        updatedAt: updatedVehicle.updatedAt,
      }],
    ]);
    return { visit, vehicle: updatedVehicle };
  });

  const later = await createBatch('later-independent-update', laterDate, 2);
  const laterVisit = await prisma.$transaction(async (transaction) => {
    const visit = await transaction.workshopVisit.create({
      data: {
        id: next('later-visit'),
        ...repairOrderIdentity(next('later-ro')),
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
      },
    });
    fixture.visitIds.push(visit.id);
    const updatedVehicle = await transaction.vehicle.update({
      where: { id: vehicle.id },
      data: { model: 'Venue' },
    });
    await addChanges(transaction, later.batch.id, later.rowProgressId, ccmId, [
      ['WorkshopVisit', visit, 'CREATE', {}, visit],
      ['Vehicle', updatedVehicle, 'UPDATE', {
        model: vehicle.model,
        updatedAt: targetChange.vehicle.updatedAt,
      }, {
        model: updatedVehicle.model,
        updatedAt: updatedVehicle.updatedAt,
      }],
    ]);
    return visit;
  });

  const preview = await previewPermanentImportDeletion(target.batch.id);
  assert.equal(preview.blockers.length, 0);
  assert.deepEqual(preview.willRestore[0].fields.saleDate, {
    before: '2020-01-01T00:00:00.000Z',
    current: '2020-03-01T00:00:00.000Z',
  });
  await permanentlyDeleteImportBatch(target.batch.id, admin.id, preview.confirmationToken);

  const [retainedCustomer, restoredVehicle, visits, laterLogs] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customer.id } }),
    prisma.vehicle.findUnique({ where: { id: vehicle.id } }),
    prisma.workshopVisit.findMany({ where: { id: { in: [unrelatedVisit.id, targetChange.visit.id, laterVisit.id] } } }),
    prisma.importChangeLog.findMany({ where: { importBatchId: later.batch.id } }),
  ]);
  assert.equal(retainedCustomer.id, customer.id);
  assert.equal(restoredVehicle.saleDate.toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal(restoredVehicle.model, 'Venue');
  assert.deepEqual(visits.map(({ id }) => id).sort(), [unrelatedVisit.id, laterVisit.id].sort());
  assert.equal(laterLogs.length, 2);
  assert.ok(laterLogs.every(({ rollbackStatus }) => rollbackStatus === 'pending'));
});

test('PostgreSQL blocks invalidated cross-batch evidence without independent reversal proof', async () => {
  const ccmId = next('ccm');
  const customer = await prisma.customer.create({
    data: {
      id: next('existing-customer'),
      customerCode: next('existing-code'),
      fullName: 'Cross-batch evidence customer',
      mobileNumber: next('mobile'),
      ccmId,
    },
  });
  fixture.customerIds.push(customer.id);
  const vehicle = await prisma.vehicle.create({
    data: {
      id: next('existing-vehicle'),
      vin: next('existing-vin'),
      customerId: customer.id,
      ccmId,
      saleDate: new Date('2020-01-01T00:00:00.000Z'),
      model: 'i20',
    },
  });
  fixture.vehicleIds.push(vehicle.id);

  const target = await createBatch('target-invalidated-cross-batch', new Date('2020-05-01T00:00:00.000Z'), 2, 'appended');
  const targetVisit = await prisma.$transaction(async (transaction) => {
    const visit = await transaction.workshopVisit.create({
      data: {
        id: next('target-visit'),
        ...repairOrderIdentity(next('target-ro')),
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
      },
    });
    fixture.visitIds.push(visit.id);
    const updatedVehicle = await transaction.vehicle.update({
      where: { id: vehicle.id },
      data: { saleDate: new Date('2020-03-01T00:00:00.000Z') },
    });
    await addChanges(transaction, target.batch.id, target.rowProgressId, ccmId, [
      ['WorkshopVisit', visit, 'CREATE', {}, visit],
      ['Vehicle', updatedVehicle, 'UPDATE', {
        saleDate: vehicle.saleDate,
        updatedAt: vehicle.updatedAt,
      }, {
        saleDate: updatedVehicle.saleDate,
        updatedAt: updatedVehicle.updatedAt,
      }],
    ]);
    return visit;
  });

  const later = await createBatch('later-invalidated-cross-batch', new Date('2021-05-01T00:00:00.000Z'), 2, 'appended');
  const laterVisit = await prisma.$transaction(async (transaction) => {
    const visit = await transaction.workshopVisit.create({
      data: {
        id: next('later-visit'),
        ...repairOrderIdentity(next('later-ro')),
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
      },
    });
    fixture.visitIds.push(visit.id);
    const updatedVehicle = await transaction.vehicle.update({
      where: { id: vehicle.id },
      data: { model: 'Venue' },
    });
    await addChanges(transaction, later.batch.id, later.rowProgressId, ccmId, [
      ['WorkshopVisit', visit, 'CREATE', {}, visit],
      ['Vehicle', updatedVehicle, 'UPDATE', {
        model: vehicle.model,
        updatedAt: (await transaction.importChangeLog.findFirst({
          where: { importBatchId: target.batch.id, entityType: 'Vehicle', entityId: vehicle.id },
          select: { after: true },
        })).after.updatedAt,
      }, {
        model: updatedVehicle.model,
        updatedAt: updatedVehicle.updatedAt,
      }],
    ]);
    return visit;
  });

  await prisma.$transaction(async (transaction) => {
    await transaction.importChangeLog.updateMany({
      where: { importBatchId: later.batch.id },
      data: {
        rollbackStatus: 'rolled_back',
        rolledBackAt: new Date(),
        rollbackError: 'Integration test: reversal is not independently verified.',
      },
    });
    await transaction.importBatch.update({
      where: { id: later.batch.id },
      data: { status: 'rolled_back' },
    });
  });

  const preview = await previewPermanentImportDeletion(target.batch.id);
  assert.equal(preview.confirmationToken, null);
  const blocker = preview.blockers.find(({ code }) => code === 'cross-batch-reversal-unverified');
  assert.ok(blocker);
  assert.equal(blocker.importBatchId, later.batch.id);
  assert.ok(blocker.changeLogId);
  assert.match(blocker.message, /cannot be independently verified/);
  assert.ok(await prisma.workshopVisit.findUnique({ where: { id: targetVisit.id } }));
  assert.ok(await prisma.workshopVisit.findUnique({ where: { id: laterVisit.id } }));
});

test('PostgreSQL concurrent confirmations apply permanent deletion at most once', async () => {
  const admin = await createAdmin();
  const { batch, rowProgressId } = await createBatch('target-concurrent', new Date('2020-06-01T00:00:00.000Z'), 3);
  const created = await createImportedCustomerVehicleVisit(batch, rowProgressId, next('ccm'));
  const preview = await previewPermanentImportDeletion(batch.id);
  assert.ok(preview.confirmationToken);

  const results = await Promise.allSettled([
    permanentlyDeleteImportBatch(batch.id, admin.id, preview.confirmationToken),
    permanentlyDeleteImportBatch(batch.id, admin.id, preview.confirmationToken),
  ]);
  const applied = results.filter((result) => result.status === 'fulfilled' && !result.value.alreadyDeleted);
  assert.equal(applied.length, 1);
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(result.reason.code === 'P2034'
        || result.reason.meta?.code === '40001'
        || result.reason.meta?.driverAdapterError?.cause?.originalCode === '40001');
    }
  }
  const [customer, vehicle, visit, currentBatch] = await Promise.all([
    prisma.customer.findUnique({ where: { id: created.customer.id } }),
    prisma.vehicle.findUnique({ where: { id: created.vehicle.id } }),
    prisma.workshopVisit.findUnique({ where: { id: created.visit.id } }),
    prisma.importBatch.findUnique({ where: { id: batch.id } }),
  ]);
  assert.equal(customer, null);
  assert.equal(vehicle, null);
  assert.equal(visit, null);
  assert.equal(currentBatch.status, 'permanently_deleted');
});

test('PostgreSQL blocks CRM workflow references and rejects stale previews without deleting business records', async () => {
  const admin = await createAdmin();
  const { batch, rowProgressId } = await createBatch('target-stale', new Date('2020-03-01T00:00:00.000Z'), 3);
  const created = await createImportedCustomerVehicleVisit(batch, rowProgressId, next('ccm'));
  const preview = await previewPermanentImportDeletion(batch.id);
  assert.ok(preview.confirmationToken);

  const call = await prisma.callLog.create({
    data: {
      id: next('late-call'),
      customerId: created.customer.id,
      vehicleId: created.vehicle.id,
      outcome: 'NO_RESPONSE',
    },
  });
  fixture.callIds.push(call.id);

  const blockedPreview = await previewPermanentImportDeletion(batch.id);
  assert.equal(blockedPreview.confirmationToken, null);
  assert.ok(blockedPreview.blockers.some(({ code }) => code === 'crm-workflow-reference'));
  await assert.rejects(
    permanentlyDeleteImportBatch(batch.id, admin.id, preview.confirmationToken),
    /blocked|changed/i,
  );
  assert.ok(await prisma.customer.findUnique({ where: { id: created.customer.id } }));
  assert.ok(await prisma.callLog.findUnique({ where: { id: call.id } }));
  assert.equal((await prisma.importBatch.findUnique({ where: { id: batch.id } })).status, 'completed');
});

test('PostgreSQL transaction failure rolls back every deletion and batch status change', async () => {
  const admin = await createAdmin();
  const { batch, rowProgressId } = await createBatch('target-rollback', new Date('2020-04-01T00:00:00.000Z'), 3);
  const created = await createImportedCustomerVehicleVisit(batch, rowProgressId, next('ccm'));
  const preview = await previewPermanentImportDeletion(batch.id);
  const failingDatabase = {
    $transaction(callback, options) {
      return prisma.$transaction((transaction) => callback(new Proxy(transaction, {
        get(target, property) {
          const delegate = Reflect.get(target, property, target);
          if (property === 'vehicle') {
            return new Proxy(delegate, {
              get(table, method) {
                if (method === 'deleteMany') return async () => { throw new Error('Injected vehicle deletion failure.'); };
                const value = Reflect.get(table, method, table);
                return typeof value === 'function' ? value.bind(table) : value;
              },
            });
          }
          return typeof delegate === 'function' ? delegate.bind(target) : delegate;
        },
      })), options);
    },
  };

  await assert.rejects(
    permanentlyDeleteImportBatch(batch.id, admin.id, preview.confirmationToken, failingDatabase),
    /Injected vehicle deletion failure/,
  );
  const [customer, vehicle, visit, currentBatch, audits] = await Promise.all([
    prisma.customer.findUnique({ where: { id: created.customer.id } }),
    prisma.vehicle.findUnique({ where: { id: created.vehicle.id } }),
    prisma.workshopVisit.findUnique({ where: { id: created.visit.id } }),
    prisma.importBatch.findUnique({ where: { id: batch.id } }),
    prisma.auditLog.findMany({ where: { entityType: 'ImportBatch', entityId: batch.id } }),
  ]);
  assert.ok(customer);
  assert.ok(vehicle);
  assert.ok(visit);
  assert.equal(currentBatch.status, 'completed');
  assert.equal(audits.length, 0);
});
