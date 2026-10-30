import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configureTestDatabaseUrl } from './testDatabaseConfig.js';

configureTestDatabaseUrl(process.env.TEST_DATABASE_URL);

const [
  { prisma },
  { previewPermanentImportDeletion, permanentlyDeleteImportBatch },
  { rollbackImportBatch },
  { recordImportChange, importSnapshot },
] = await Promise.all([
  import('../../src/config/prisma.js'),
  import('../../src/services/permanentImportDeletionService.js'),
  import('../../src/services/importRollbackService.js'),
  import('../../src/utils/importChangeLog.js'),
]);

const prefix = `it_${randomUUID().replaceAll('-', '')}`;
const fixtureIds = {
  user: `${prefix}_admin`,
  batches: [`${prefix}_february`, `${prefix}_march`],
  customers: [`${prefix}_imported`, `${prefix}_existing`],
  vehicles: [`${prefix}_vehicle`],
  visits: [`${prefix}_feb_ro`, `${prefix}_march_ro`, `${prefix}_april_ro`],
  callLists: [`${prefix}_feb_call_list`, `${prefix}_may_call_list`],
  calls: [`${prefix}_call_log`],
  followUps: [`${prefix}_follow_up`],
  appointments: [`${prefix}_appointment`],
  appointmentEvents: [`${prefix}_appointment_event`],
  allocations: [`${prefix}_allocation`],
  ownership: [`${prefix}_ownership`],
  milestones: [`${prefix}_milestone`],
  monthlyEntries: [`${prefix}_monthly_entry`],
  monthlyDatasets: [`${prefix}_dataset`],
  vinReviews: [`${prefix}_vin_review`],
};

function next(label) {
  return `${prefix}_${label}_${randomUUID().replaceAll('-', '')}`;
}

function transactionThatFailsAtVehicleDelete(database) {
  return {
    $transaction(callback, options) {
      return database.$transaction((transaction) => callback(new Proxy(transaction, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'vehicle' && value) {
            return new Proxy(value, {
              get(delegate, method) {
                if (method === 'deleteMany') {
                  return async () => { throw new Error('Injected failure at vehicle deletion.'); };
                }
                const delegateMethod = Reflect.get(delegate, method, delegate);
                return typeof delegateMethod === 'function' ? delegateMethod.bind(delegate) : delegateMethod;
              },
            });
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })), options);
    },
  };
}

async function seedCascadeFixture() {
  const [targetBatchId, laterBatchId] = fixtureIds.batches;
  const [targetProgressId, marchProgressId, aprilProgressId] = [next('feb-progress'), next('march-progress'), next('april-progress')];
  const ccmId = next('ccm');
  const targetDate = new Date('2026-02-01T00:00:00.000Z');
  const laterDate = new Date('2026-03-01T00:00:00.000Z');
  const admin = await prisma.user.create({
    data: {
      id: fixtureIds.user,
      name: 'Permanent Deletion Integration Admin',
      password: 'integration-only-placeholder',
      role: 'ADMIN',
    },
  });
  const [targetBatch, laterBatch] = await Promise.all([
    prisma.importBatch.create({
      data: {
        id: targetBatchId,
        fileName: 'february-origin.csv',
        status: 'completed',
        rollbackSupported: true,
        totalRows: 1,
        processedRows: 1,
        allocationEvidenceState: 'not_started',
        createdAt: targetDate,
        rowProgress: {
          create: {
            id: targetProgressId,
            rowNumber: 2,
            status: 'completed',
            outcome: 'created',
            mutationState: 'complete',
            loggedChangeCount: 0,
          },
        },
      },
    }),
    prisma.importBatch.create({
      data: {
        id: laterBatchId,
        fileName: 'march-april-follow-on.csv',
        status: 'completed',
        rollbackSupported: true,
        totalRows: 2,
        processedRows: 2,
        allocationEvidenceState: 'not_started',
        createdAt: laterDate,
        rowProgress: {
          create: [
            {
              id: marchProgressId,
              rowNumber: 2,
              status: 'completed',
              outcome: 'created',
              mutationState: 'complete',
              loggedChangeCount: 0,
            },
            {
              id: aprilProgressId,
              rowNumber: 3,
              status: 'completed',
              outcome: 'created',
              mutationState: 'complete',
              loggedChangeCount: 0,
            },
          ],
        },
      },
    }),
  ]);
  const previousCustomer = await prisma.customer.create({
    data: {
      id: fixtureIds.customers[1],
      customerCode: next('existing-code'),
      fullName: 'Pre-existing customer',
      mobileNumber: '9199990000',
      ccmId,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  const created = await prisma.$transaction(async (transaction) => {
    const customer = await transaction.customer.create({
      data: {
        id: fixtureIds.customers[0],
        customerCode: next('imported-code'),
        fullName: 'February import customer',
        mobileNumber: '9199990001',
        ccmId,
      },
    });
    const vehicle = await transaction.vehicle.create({
      data: {
        id: fixtureIds.vehicles[0],
        vin: next('vin'),
        registrationNumber: next('registration'),
        customerId: customer.id,
        ccmId,
      },
    });
    const repairOrder = await transaction.workshopVisit.create({
      data: {
        id: fixtureIds.visits[0],
        repairOrderNo: next('ro-feb'),
        customerId: customer.id,
        vehicleId: vehicle.id,
        ccmId,
        importedDetails: { source: 'February' },
      },
    });
    const targetCallList = await transaction.masterCallList.create({
      data: {
        id: fixtureIds.callLists[0],
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber,
        vin: vehicle.vin,
        ccmId,
      },
    });
    const previousState = { fullName: previousCustomer.fullName, updatedAt: previousCustomer.updatedAt };
    const updatedCustomer = await transaction.customer.update({
      where: { id: previousCustomer.id },
      data: { fullName: 'Temporarily updated by February import' },
    });
    const changes = [
      ['Customer', customer, 'CREATE', {}, customer],
      ['Vehicle', vehicle, 'CREATE', {}, vehicle],
      ['WorkshopVisit', repairOrder, 'CREATE', {}, repairOrder],
      ['MasterCallList', targetCallList, 'CREATE', {}, targetCallList],
      [
        'Customer',
        updatedCustomer,
        'UPDATE',
        previousState,
        { fullName: updatedCustomer.fullName, updatedAt: updatedCustomer.updatedAt },
      ],
    ];
    for (const [index, [entityType, record, operation, before, afterState]] of changes.entries()) {
      await recordImportChange(transaction, {
        importBatchId: targetBatch.id,
        rowProgressId: targetProgressId,
        sequence: index + 1,
        entityType,
        entityId: record.id,
        ccmId,
        operation,
        before: importSnapshot(before),
        after: importSnapshot(afterState),
      });
    }
    await transaction.importRowProgress.update({
      where: { id: targetProgressId },
      data: { loggedChangeCount: changes.length },
    });

    const laterVisitRecords = [];
    for (const [index, [id, rowProgressId]] of [
      [fixtureIds.visits[1], marchProgressId],
      [fixtureIds.visits[2], aprilProgressId],
    ].entries()) {
      const laterVisit = await transaction.workshopVisit.create({
        data: {
          id,
          repairOrderNo: next(index ? 'ro-april' : 'ro-march'),
          customerId: customer.id,
          vehicleId: vehicle.id,
          ccmId,
          importedDetails: { source: index ? 'April' : 'March' },
        },
      });
      laterVisitRecords.push(laterVisit);
      await recordImportChange(transaction, {
        importBatchId: laterBatch.id,
        rowProgressId,
        sequence: index + 1,
        entityType: 'WorkshopVisit',
        entityId: laterVisit.id,
        ccmId,
        operation: 'CREATE',
        before: {},
        after: importSnapshot(laterVisit),
      });
    }
    const laterCallList = await transaction.masterCallList.create({
      data: {
        id: fixtureIds.callLists[1],
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber,
        vin: vehicle.vin,
        ccmId,
      },
    });
    await recordImportChange(transaction, {
      importBatchId: laterBatch.id,
      rowProgressId: marchProgressId,
      sequence: 3,
      entityType: 'MasterCallList',
      entityId: laterCallList.id,
      ccmId,
      operation: 'CREATE',
      before: {},
      after: importSnapshot(laterCallList),
    });
    await transaction.importRowProgress.update({
      where: { id: marchProgressId },
      data: { loggedChangeCount: 2 },
    });
    await transaction.importRowProgress.update({
      where: { id: aprilProgressId },
      data: { loggedChangeCount: 1 },
    });

    const allocation = await transaction.allocation.create({
      data: { id: fixtureIds.allocations[0], vehicleId: vehicle.id, ccmId, serviceType: 'integration-test' },
    });
    const milestone = await transaction.freeServiceMilestone.create({
      data: {
        id: fixtureIds.milestones[0],
        vehicleId: vehicle.id,
        milestone: 1,
        dueDate: new Date('2026-04-01T00:00:00.000Z'),
      },
    });
    const call = await transaction.callLog.create({
      data: {
        id: fixtureIds.calls[0],
        customerId: customer.id,
        vehicleId: vehicle.id,
        milestoneId: milestone.id,
        outcome: 'NO_RESPONSE',
      },
    });
    const followUp = await transaction.followUp.create({
      data: {
        id: fixtureIds.followUps[0],
        customerId: customer.id,
        vehicleId: vehicle.id,
        milestoneId: milestone.id,
        followUpAt: new Date('2026-04-02T00:00:00.000Z'),
        category: 'integration-test',
      },
    });
    const appointment = await transaction.appointment.create({
      data: {
        id: fixtureIds.appointments[0],
        customerId: customer.id,
        vehicleId: vehicle.id,
        customerName: customer.fullName,
        vehicleName: vehicle.model || 'Integration vehicle',
        scheduledAt: new Date('2026-04-03T00:00:00.000Z'),
      },
    });
    const appointmentEvent = await transaction.appointmentEvent.create({
      data: {
        id: fixtureIds.appointmentEvents[0],
        appointmentId: appointment.id,
        eventType: 'integration-test',
      },
    });
    const ownership = await transaction.vehicleOwnershipHistory.create({
      data: { id: fixtureIds.ownership[0], vehicleId: vehicle.id, reason: 'integration-test' },
    });
    const dataset = await transaction.monthlyCustomerDataset.create({
      data: {
        id: fixtureIds.monthlyDatasets[0],
        ccmId: next('monthly-ccm'),
        year: 2026,
        month: 10,
      },
    });
    const monthlyEntry = await transaction.monthlyCustomerDataEntry.create({
      data: {
        id: fixtureIds.monthlyEntries[0],
        datasetId: dataset.id,
        customerId: customer.id,
        vehicleId: vehicle.id,
        dedupeKey: next('monthly-dedupe'),
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber || '',
        vin: vehicle.vin,
      },
    });
    const conflictReview = await transaction.vINConflictReview.create({
      data: {
        id: fixtureIds.vinReviews[0],
        vin: vehicle.vin,
        sourceCcmId: ccmId,
        targetCcmId: next('target-ccm'),
        reason: 'integration-test',
      },
    });

    return {
      customer, vehicle, repairOrder, targetCallList, laterCallList, laterVisitRecords,
      allocation, milestone, call, followUp, appointment, appointmentEvent,
      ownership, dataset, monthlyEntry, conflictReview,
    };
  });
  return { admin, targetBatch, laterBatch, previousCustomer, created };
}

async function cleanupFixture() {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: fixtureIds.batches } },
        { userId: fixtureIds.user },
      ],
    },
  });
  await prisma.appointmentEvent.deleteMany({ where: { id: { in: fixtureIds.appointmentEvents } } });
  await prisma.callLog.deleteMany({ where: { id: { in: fixtureIds.calls } } });
  await prisma.followUp.deleteMany({ where: { id: { in: fixtureIds.followUps } } });
  await prisma.appointment.deleteMany({ where: { id: { in: fixtureIds.appointments } } });
  await prisma.allocation.deleteMany({ where: { id: { in: fixtureIds.allocations } } });
  await prisma.vehicleOwnershipHistory.deleteMany({ where: { id: { in: fixtureIds.ownership } } });
  await prisma.monthlyCustomerDataEntry.deleteMany({ where: { id: { in: fixtureIds.monthlyEntries } } });
  await prisma.workshopVisit.deleteMany({ where: { id: { in: fixtureIds.visits } } });
  await prisma.masterCallList.deleteMany({ where: { id: { in: fixtureIds.callLists } } });
  await prisma.freeServiceMilestone.deleteMany({ where: { id: { in: fixtureIds.milestones } } });
  await prisma.vINConflictReview.deleteMany({ where: { id: { in: fixtureIds.vinReviews } } });
  await prisma.importBatch.deleteMany({ where: { id: { in: fixtureIds.batches } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: fixtureIds.vehicles } } });
  await prisma.customer.deleteMany({ where: { id: { in: fixtureIds.customers } } });
  await prisma.monthlyCustomerDataset.deleteMany({ where: { id: { in: fixtureIds.monthlyDatasets } } });
  await prisma.user.deleteMany({ where: { id: fixtureIds.user } });
}

afterEach(cleanupFixture);
after(async () => { await prisma.$disconnect(); });

test('PostgreSQL permanent deletion cascades dependencies, restores shared state, retains audit, and blocks re-creation on rollback', async () => {
  const { admin, targetBatch, laterBatch, previousCustomer, created } = await seedCascadeFixture();
  const preview = await previewPermanentImportDeletion(targetBatch.id);

  assert.equal(preview.fileName, targetBatch.fileName);
  assert.equal(preview.directlyAffectedRecords, 4);
  assert.equal(preview.laterImportBatchesAffected, 1);
  assert.equal(preview.existingRecordsRestored, 1);
  assert.ok(preview.confirmationToken);
  assert.ok(preview.totalRecordsDeleted >= 13);

  const result = await permanentlyDeleteImportBatch(targetBatch.id, admin.id, preview.confirmationToken);
  assert.equal(result.status, 'permanently_deleted');

  const [deletedCustomer, deletedVehicle, repairOrders, calls, followUps, appointments, callLists, allocations, ownership, milestone, monthlyEntry, restoredCustomer, retainedTargetBatch, retainedLaterBatch, retainedAudits, targetChanges, laterChanges] = await Promise.all([
    prisma.customer.findUnique({ where: { id: created.customer.id } }),
    prisma.vehicle.findUnique({ where: { id: created.vehicle.id } }),
    prisma.workshopVisit.findMany({ where: { id: { in: fixtureIds.visits } } }),
    prisma.callLog.findMany({ where: { id: { in: fixtureIds.calls } } }),
    prisma.followUp.findMany({ where: { id: { in: fixtureIds.followUps } } }),
    prisma.appointment.findMany({ where: { id: { in: fixtureIds.appointments } } }),
    prisma.masterCallList.findMany({ where: { id: { in: fixtureIds.callLists } } }),
    prisma.allocation.findMany({ where: { id: { in: fixtureIds.allocations } } }),
    prisma.vehicleOwnershipHistory.findMany({ where: { id: { in: fixtureIds.ownership } } }),
    prisma.freeServiceMilestone.findUnique({ where: { id: created.milestone.id } }),
    prisma.monthlyCustomerDataEntry.findUnique({ where: { id: created.monthlyEntry.id } }),
    prisma.customer.findUnique({ where: { id: previousCustomer.id } }),
    prisma.importBatch.findUnique({ where: { id: targetBatch.id } }),
    prisma.importBatch.findUnique({ where: { id: laterBatch.id } }),
    prisma.auditLog.findMany({ where: { entityType: 'ImportBatch', entityId: targetBatch.id } }),
    prisma.importChangeLog.findMany({ where: { importBatchId: targetBatch.id } }),
    prisma.importChangeLog.findMany({ where: { importBatchId: laterBatch.id } }),
  ]);
  assert.equal(deletedCustomer, null);
  assert.equal(deletedVehicle, null);
  assert.deepEqual(repairOrders, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(followUps, []);
  assert.deepEqual(appointments, []);
  assert.deepEqual(callLists, []);
  assert.deepEqual(allocations, []);
  assert.deepEqual(ownership, []);
  assert.equal(milestone, null);
  assert.equal(monthlyEntry.customerId, null);
  assert.equal(monthlyEntry.vehicleId, null);
  assert.equal(restoredCustomer.fullName, 'Pre-existing customer');
  assert.equal(restoredCustomer.updatedAt.toISOString(), previousCustomer.updatedAt.toISOString());
  assert.equal(retainedTargetBatch.status, 'permanently_deleted');
  assert.equal(retainedLaterBatch.status, 'completed');
  assert.equal(retainedAudits.length, 1);
  assert.equal(retainedAudits[0].userId, admin.id);
  assert.equal(retainedAudits[0].action, 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED');
  assert.ok(targetChanges.every(({ rollbackStatus }) => rollbackStatus === 'permanently_deleted'));
  assert.equal(laterChanges.filter(({ rollbackStatus }) => rollbackStatus === 'permanently_deleted').length, 3);

  const rollback = await rollbackImportBatch(laterBatch.id, admin.id);
  assert.equal(rollback.batch.status, 'rolled_back');
  assert.equal(rollback.reversedChanges, 0);
  assert.deepEqual(await prisma.workshopVisit.findMany({ where: { id: { in: fixtureIds.visits } } }), []);
});

test('PostgreSQL permanent deletion tolerates already-missing imported customer and vehicle records', async () => {
  const { admin, targetBatch, previousCustomer, created } = await seedCascadeFixture();
  await prisma.$transaction(async (transaction) => {
    await transaction.appointmentEvent.deleteMany({ where: { id: { in: fixtureIds.appointmentEvents } } });
    await transaction.callLog.deleteMany({ where: { id: { in: fixtureIds.calls } } });
    await transaction.followUp.deleteMany({ where: { id: { in: fixtureIds.followUps } } });
    await transaction.appointment.deleteMany({ where: { id: { in: fixtureIds.appointments } } });
    await transaction.vehicleOwnershipHistory.deleteMany({ where: { id: { in: fixtureIds.ownership } } });
    await transaction.allocation.deleteMany({ where: { id: { in: fixtureIds.allocations } } });
    await transaction.workshopVisit.deleteMany({ where: { id: { in: fixtureIds.visits } } });
    await transaction.masterCallList.deleteMany({ where: { id: { in: fixtureIds.callLists } } });
    await transaction.monthlyCustomerDataEntry.deleteMany({ where: { id: { in: fixtureIds.monthlyEntries } } });
    await transaction.freeServiceMilestone.deleteMany({ where: { id: { in: fixtureIds.milestones } } });
    await transaction.vINConflictReview.deleteMany({ where: { id: { in: fixtureIds.vinReviews } } });
    await transaction.vehicle.delete({ where: { id: created.vehicle.id } });
    await transaction.customer.delete({ where: { id: created.customer.id } });
  });

  const preview = await previewPermanentImportDeletion(targetBatch.id);
  assert.deepEqual(
    preview.recordsAlreadyAbsent.map(({ entityType }) => entityType),
    ['Customer', 'MasterCallList', 'Vehicle', 'WorkshopVisit'],
  );
  assert.equal(preview.directlyAffectedRecords, 0);
  const result = await permanentlyDeleteImportBatch(targetBatch.id, admin.id, preview.confirmationToken);

  const [retainedCustomer, retainedBatch, audits, changes] = await Promise.all([
    prisma.customer.findUnique({ where: { id: previousCustomer.id } }),
    prisma.importBatch.findUnique({ where: { id: targetBatch.id } }),
    prisma.auditLog.findMany({ where: { entityType: 'ImportBatch', entityId: targetBatch.id } }),
    prisma.importChangeLog.findMany({ where: { importBatchId: targetBatch.id } }),
  ]);
  assert.equal(result.status, 'permanently_deleted');
  assert.equal(retainedBatch.status, 'permanently_deleted');
  assert.equal(retainedCustomer.fullName, 'Pre-existing customer');
  assert.equal(audits.length, 1);
  assert.ok(changes.every(({ rollbackStatus }) => rollbackStatus === 'permanently_deleted'));
  assert.equal(await prisma.importBatch.count({ where: { id: targetBatch.id } }), 1);
});

test('PostgreSQL rolls back every deletion and restoration when a dependent delete fails', async () => {
  const { admin, targetBatch, previousCustomer, created } = await seedCascadeFixture();
  const preview = await previewPermanentImportDeletion(targetBatch.id);
  const originalUpdatedCustomer = await prisma.customer.findUnique({ where: { id: previousCustomer.id } });
  const originalTargetBatch = await prisma.importBatch.findUnique({ where: { id: targetBatch.id } });

  await assert.rejects(
    permanentlyDeleteImportBatch(
      targetBatch.id,
      admin.id,
      preview.confirmationToken,
      transactionThatFailsAtVehicleDelete(prisma),
    ),
    /Injected failure at vehicle deletion/,
  );

  const [customer, vehicle, visits, callList, call, appointment, monthlyEntry, updatedCustomer, currentBatch, auditCount, changeStates] = await Promise.all([
    prisma.customer.findUnique({ where: { id: created.customer.id } }),
    prisma.vehicle.findUnique({ where: { id: created.vehicle.id } }),
    prisma.workshopVisit.findMany({ where: { id: { in: fixtureIds.visits } } }),
    prisma.masterCallList.findMany({ where: { id: { in: fixtureIds.callLists } } }),
    prisma.callLog.findUnique({ where: { id: created.call.id } }),
    prisma.appointment.findUnique({ where: { id: created.appointment.id } }),
    prisma.monthlyCustomerDataEntry.findUnique({ where: { id: created.monthlyEntry.id } }),
    prisma.customer.findUnique({ where: { id: previousCustomer.id } }),
    prisma.importBatch.findUnique({ where: { id: targetBatch.id } }),
    prisma.auditLog.count({ where: { entityType: 'ImportBatch', entityId: targetBatch.id } }),
    prisma.importChangeLog.findMany({ where: { importBatchId: targetBatch.id } }),
  ]);
  assert.ok(customer);
  assert.ok(vehicle);
  assert.equal(visits.length, 3);
  assert.equal(callList.length, 2);
  assert.ok(call);
  assert.ok(appointment);
  assert.equal(monthlyEntry.customerId, customer.id);
  assert.equal(monthlyEntry.vehicleId, vehicle.id);
  assert.equal(updatedCustomer.fullName, originalUpdatedCustomer.fullName);
  assert.equal(updatedCustomer.updatedAt.toISOString(), originalUpdatedCustomer.updatedAt.toISOString());
  assert.equal(currentBatch.status, originalTargetBatch.status);
  assert.equal(auditCount, 0);
  assert.ok(changeStates.every(({ rollbackStatus }) => rollbackStatus === 'pending'));
});

test('PostgreSQL rejects a stale deletion preview when dependent records change', async () => {
  const { admin, targetBatch, created } = await seedCascadeFixture();
  const preview = await previewPermanentImportDeletion(targetBatch.id);
  const lateCallId = next('late-call');
  fixtureIds.calls.push(lateCallId);
  await prisma.callLog.create({
    data: {
      id: lateCallId,
      customerId: created.customer.id,
      vehicleId: created.vehicle.id,
      outcome: 'NO_RESPONSE',
    },
  });

  await assert.rejects(
    permanentlyDeleteImportBatch(targetBatch.id, admin.id, preview.confirmationToken),
    /scope changed after preview/,
  );
  assert.ok(await prisma.customer.findUnique({ where: { id: created.customer.id } }));
  assert.ok(await prisma.callLog.findUnique({ where: { id: lateCallId } }));
  assert.equal((await prisma.importBatch.findUnique({ where: { id: targetBatch.id } })).status, 'completed');
  assert.equal(await prisma.auditLog.count({ where: { entityId: targetBatch.id } }), 0);
});

test('concurrent PostgreSQL permanent deletions serialize and retain one audit record', async () => {
  const { admin, targetBatch } = await seedCascadeFixture();
  const preview = await previewPermanentImportDeletion(targetBatch.id);
  const attempts = await Promise.allSettled([
    permanentlyDeleteImportBatch(targetBatch.id, admin.id, preview.confirmationToken),
    permanentlyDeleteImportBatch(targetBatch.id, admin.id, preview.confirmationToken),
  ]);
  const succeeded = attempts.filter(({ status }) => status === 'fulfilled');
  assert.equal(succeeded.length, 1);
  const rejected = attempts.find(({ status }) => status === 'rejected');
  assert.ok(rejected, 'One concurrent deletion must be rejected.');
  assert.ok(
    rejected.reason.code === 'P2034'
      || (rejected.reason.code === 'P2010' && rejected.reason.meta?.code === '40001')
      || (rejected.reason.code === 'P2010'
        && rejected.reason.meta?.driverAdapterError?.cause?.originalCode === '40001')
      || rejected.reason.name === 'PermanentImportDeletionConflict',
    `Unexpected concurrent deletion error: ${rejected.reason.name} ${rejected.reason.code || ''} ${JSON.stringify(rejected.reason.meta)} ${rejected.reason.message}`,
  );

  const retry = await permanentlyDeleteImportBatch(targetBatch.id, admin.id, preview.confirmationToken);
  assert.equal(retry.alreadyDeleted, true);
  assert.equal(await prisma.auditLog.count({
    where: { entityType: 'ImportBatch', entityId: targetBatch.id, action: 'REPAIR_ORDER_IMPORT_PERMANENTLY_DELETED' },
  }), 1);
  assert.equal(await prisma.customer.count({ where: { id: `${prefix}_imported` } }), 0);
});
