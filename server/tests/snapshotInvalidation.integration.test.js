import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.SNAPSHOT_INTEGRATION_DATABASE_URL;

test('workflow, monthly and shared-history writes invalidate snapshots transactionally', { skip: !databaseUrl, timeout: 30000 }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/(?:snapshot_test_[a-z0-9_]+|status_test_ci)$/);
  for (const [key, value] of url.searchParams) assert.ok(key === 'schema' && value === 'public');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'true';
  process.env.SERVICE_CONTACT_STATUS_ENABLED = 'false';
  const { prisma } = await import('../src/config/prisma.js');
  const { setSnapshotRefreshHandler } = await import('../src/utils/performanceRefreshSignal.js');
  const { beginSnapshotInvalidation, flushSnapshotInvalidation, invalidateSnapshotSourceWrite } = await import('../src/utils/performanceSnapshotState.js');
  const { refreshSnapshot } = await import('../src/services/performanceSnapshotService.js');
  const { createCallLog, createFollowUp, updateFollowUpStatus } = await import('../src/controllers/callWorkflowController.js');
  const { createAppointment, updateAppointment, deleteAppointment } = await import('../src/controllers/appointmentController.js');
  const { createManualCallListEntry, updateCallListAssignee } = await import('../src/controllers/recordsController.js');
  const { updateUserStatus, updateManagedUser, assignUserToCcm, deleteManagedUser } = await import('../src/controllers/userController.js');
  const { createMonthlyCustomerEntry } = await import('../src/controllers/monthlyCustomerDataController.js');
  const { createCustomer } = await import('../src/controllers/customerController.js');
  const { backfillVehicleSaleDates } = await import('../src/config/backfillSaleDates.js');
  const { syncFreeServiceMilestones } = await import('../src/utils/serviceLists.js');
  const { importRepairOrders } = await import('../src/controllers/importController.js');
  const { rollbackImportBatch } = await import('../src/services/importRollbackService.js');
  const { previewPermanentImportDeletion, permanentlyDeleteImportBatch } = await import('../src/services/permanentImportDeletionService.js');
  setSnapshotRefreshHandler(() => {});
  const id = randomUUID();
  const vin = `1HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const secondVin = `2HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const customerVin = `3HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const importedVin = `4HG${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const team = `${id}-team`;
  const otherTeam = `${id}-other`;
  const cre = `${id}-cre`;
  const secondCre = `${id}-cre-2`;
  const user = { id: `${id}-ccm`, name: 'Test CCM', role: 'CCM', ccmId: team };
  const otherUser = { id: `${id}-other-ccm`, name: 'Other CCM', role: 'CCM', ccmId: otherTeam };
  const response = () => ({
    locals: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const key = { creId: cre, ccmId: team, year: 2026, month: 11, viewer: 'CRE' };
  const snapshotWhere = { creId_ccmId_year_month_viewer: key };
  const read = () => prisma.crePerformanceSnapshot.findUniqueOrThrow({ where: snapshotWhere });
  const reset = () => prisma.crePerformanceSnapshot.update({ where: snapshotWhere, data: { status: 'ok', dirtySince: null } });
  const verifyWrite = async (action) => {
    await reset();
    const before = await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } });
    const res = response();
    await action(res);
    assert.ok(res.statusCode < 400);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision, before.revision + 1n);
    const untouched = await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } });
    assert.equal(untouched.status, 'ok');
    return res;
  };
  let release;
  let pending;
  const importBatchIds = [];
  try {
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: 'global' }, { scope: `ccm:${team}` }], skipDuplicates: true });
    await prisma.user.createMany({ data: [
      { ...user, password: 'test' },
      { ...otherUser, password: 'test' },
      { id: cre, name: 'Test CRE', role: 'CRE', ccmId: team, password: 'test' },
      { id: secondCre, username: `c${id.replaceAll('-', '').slice(0, 20)}`, name: 'Second CRE', role: 'CRE', ccmId: team, password: 'test' },
    ] });
    const customer = await prisma.customer.create({ data: { customerCode: id, fullName: 'Test customer', ccmId: team } });
    const physical = await prisma.physicalVehicle.create({ data: { vin } });
    const vehicle = await prisma.vehicle.create({ data: { vin, physicalVehicleId: physical.id, customerId: customer.id, ccmId: team } });
    const otherCustomer = await prisma.customer.create({ data: { customerCode: `${id}-other`, fullName: 'Other customer', ccmId: otherTeam } });
    await prisma.vehicle.create({ data: { vin, physicalVehicleId: physical.id, customerId: otherCustomer.id, ccmId: otherTeam } });
    await prisma.crePerformanceSnapshot.createMany({ data: [
      { ...key, status: 'ok', callsThisMonth: 7, computedAt: new Date() },
      { ...key, month: 10, status: 'ok', callsThisMonth: 6, computedAt: new Date() },
      { ...key, creId: `${id}-other-cre`, ccmId: otherTeam, status: 'ok', callsThisMonth: 9, computedAt: new Date() },
    ] });
    const body = { customerId: customer.id, vehicleId: vehicle.id };
    const future = new Date(Date.now() + 86400000).toISOString();
    await verifyWrite((res) => createCallLog({ user, body: { ...body, outcome: 'CONTACTED' } }, res));
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({
      where: { creId_ccmId_year_month_viewer: { ...key, month: 10 } },
    })).status, 'dirty');
    await verifyWrite((res) => createMonthlyCustomerEntry({
      user, params: { ccmId: team }, query: { year: '2026', month: '11' },
      body: { vin, customerName: 'Test customer', mobileNumber: '9000000000' },
    }, res));
    const entry = await prisma.masterCallList.findFirstOrThrow({ where: { ccmId: team, vin } });
    await reset();
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: team, month: 10 }, data: { status: 'ok', dirtySince: null } });
    let assignmentStarted;
    const assignmentEntered = new Promise((resolve) => { assignmentStarted = resolve; });
    const assignmentBlocked = new Promise((resolve) => { release = resolve; });
    pending = refreshSnapshot(key, { compute: async () => {
      assignmentStarted();
      await assignmentBlocked;
      return { callsThisMonth: 99, details: {}, asOf: new Date() };
    } });
    await assignmentEntered;
    const assigned = response();
    const assignmentRevision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision;
    await updateCallListAssignee({ user, params: { id: entry.id }, body: { assigneeId: secondCre } }, assigned);
    assert.equal(assigned.statusCode, 200);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision, assignmentRevision + 1n);
    assert.equal((await prisma.crePerformanceSnapshot.findUniqueOrThrow({
      where: { creId_ccmId_year_month_viewer: { ...key, month: 10 } },
    })).status, 'dirty');
    release();
    assert.deepEqual(await pending, { refreshed: false, reason: 'dirty' });
    pending = null;
    assert.equal((await read()).callsThisMonth, 7);
    await verifyWrite((res) => updateUserStatus({
      user, params: { id: secondCre }, body: { status: 'inactive' },
    }, res));
    await verifyWrite((res) => createCustomer({
      user, body: { fullName: 'New customer', vehicles: [{ vin: customerVin }] },
    }, res));
    const followUp = await verifyWrite((res) => createFollowUp({ user, body: { ...body, category: 'CALLBACK', followUpAt: future } }, res));
    await verifyWrite((res) => updateFollowUpStatus({ user, params: { id: followUp.body.followUp.id }, body: { status: 'completed' } }, res));
    const appointment = await verifyWrite((res) => createAppointment({ user, body: { ...body, scheduledAt: future } }, res));
    await verifyWrite((res) => updateAppointment({ user, params: { id: appointment.body.appointment.id }, body: { status: 'CONFIRMED' } }, res));
    await verifyWrite((res) => deleteAppointment({ user, params: { id: appointment.body.appointment.id } }, res));

    await reset();
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    pending = refreshSnapshot(key, { compute: async () => {
      started();
      await blocked;
      return { callsThisMonth: 99, details: {}, asOf: new Date() };
    } });
    await entered;
    const concurrent = response();
    await createFollowUp({ user, body: { ...body, category: 'CALLBACK', followUpAt: future } }, concurrent);
    assert.equal(concurrent.statusCode, 201);
    release();
    assert.deepEqual(await pending, { refreshed: false, reason: 'dirty' });
    pending = null;
    assert.equal((await read()).callsThisMonth, 7);
    assert.equal((await read()).status, 'dirty');

    await reset();
    const priorRevision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision;
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: customer.id }, data: { fullName: 'Rolled back' } });
      await invalidateSnapshotSourceWrite(tx, { ccmIds: [team] });
      throw new Error('forced rollback');
    }), /forced rollback/);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).fullName, 'Test customer');
    assert.equal((await read()).status, 'ok');
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision, priorRevision);

    const globalBefore = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision;
    await assert.rejects(prisma.$transaction(async (tx) => {
      await invalidateSnapshotSourceWrite(tx, { ccmIds: [null] });
      assert.equal((await tx.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, globalBefore);
      assert.equal((await tx.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'ok');
      throw new Error('forced fallback rollback');
    }), /forced fallback rollback/);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, globalBefore);
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'ok');

    const manual = response();
    await createManualCallListEntry({ user, body: {
      roNumber: `${id}-manual`, vin, customerName: 'Test customer', mobileNumber: '9000000000',
      visitDate: '2026-01-15', saleDate: '2025-01-15',
    } }, manual);
    assert.equal(manual.statusCode, 201);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    await reset();
    const globalRevision = await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } });
    await prisma.performanceSnapshotRevision.delete({ where: { scope: 'global' } });
    try {
      await assert.rejects(createManualCallListEntry({ user, body: {
        roNumber: `${id}-invalid-revision`, vin, customerName: 'Test customer', mobileNumber: '9000000000',
        visitDate: '2026-01-16', saleDate: '2025-01-15',
      } }, response()));
      assert.equal(await prisma.workshopVisit.count({ where: { ccmId: team, repairOrderNo: `${id}-invalid-revision` } }), 0);
      assert.equal((await read()).status, 'ok');
    } finally {
      await prisma.performanceSnapshotRevision.create({ data: globalRevision });
    }
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: null } });
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    const scopedBackfillDb = {
      vehicle: { findMany: (args) => prisma.vehicle.findMany({ ...args, where: { ...args.where, id: vehicle.id } }) },
      $transaction: (callback) => prisma.$transaction(callback),
    };
    const failedBackfillDb = {
      ...scopedBackfillDb,
      $transaction: (callback) => prisma.$transaction((transaction) => callback(new Proxy(transaction, {
        get(target, property) {
          if (property === 'performanceSnapshotRevision') return { upsert: async () => { throw new Error('injected invalidation failure'); } };
          return Reflect.get(target, property, target);
        },
      }))),
    };
    await assert.rejects(backfillVehicleSaleDates(failedBackfillDb), /injected invalidation failure/);
    assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).saleDate, null);
    assert.equal((await read()).status, 'ok');
    let backfillStarted;
    const enteredBackfill = new Promise((resolve) => { backfillStarted = resolve; });
    const blockedBackfill = new Promise((resolve) => { release = resolve; });
    pending = refreshSnapshot(key, { compute: async () => {
      backfillStarted();
      await blockedBackfill;
      return { callsThisMonth: 111, details: {}, asOf: new Date() };
    } });
    await enteredBackfill;
    assert.equal(await backfillVehicleSaleDates(scopedBackfillDb), 1);
    release();
    assert.deepEqual(await pending, { refreshed: false, reason: 'dirty' });
    pending = null;
    assert.equal((await read()).callsThisMonth, 7);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'ok');
    assert.equal(await backfillVehicleSaleDates(scopedBackfillDb), 0);
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    const milestoneInput = [{ id: vehicle.id, physicalVehicleId: physical.id, saleDate: new Date('2025-01-15T00:00:00Z'), workshopVisits: [] }];
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: milestoneInput[0].saleDate } });
    await prisma.freeServiceMilestone.deleteMany({ where: { vehicleId: vehicle.id } });
    const failedMilestoneDb = {
      $queryRawUnsafe: async () => [],
      freeServiceMilestone: prisma.freeServiceMilestone,
      $transaction: (callback) => prisma.$transaction(async (transaction) => {
        const proxy = new Proxy(transaction, {
          get(target, property) {
            if (property === 'performanceSnapshotRevision') return { update: async () => { throw new Error('injected milestone invalidation failure'); } };
            return Reflect.get(target, property, target);
          },
        });
        beginSnapshotInvalidation(proxy);
        const result = await callback(proxy);
        await flushSnapshotInvalidation(proxy);
        return result;
      }),
    };
    await assert.rejects(syncFreeServiceMilestones(milestoneInput, failedMilestoneDb), /injected milestone invalidation failure/);
    assert.equal(await prisma.freeServiceMilestone.count({ where: { vehicleId: vehicle.id } }), 0);
    assert.equal((await read()).status, 'ok');
    const milestones = await syncFreeServiceMilestones(milestoneInput);
    assert.ok(milestones.length);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    const revisionAfterMilestones = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision;
    await syncFreeServiceMilestones(milestoneInput);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, revisionAfterMilestones);
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    const imported = response();
    await importRepairOrders({
      user, get: () => '', body: {
        fileName: 'invalidation.csv',
        content: [
          'RO Number,VIN,Customer Name,Mobile,Make,Model,Total Labor Cost,Total Parts Cost,Visit Date',
          `${id}-import,${vin},Test customer,9000000000,Hyundai,Test,100,50,2026-02-15`,
        ].join('\n'),
      },
    }, imported);
    assert.equal(imported.statusCode, 201);
    importBatchIds.push(imported.body.batch.id);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    await rollbackImportBatch(importBatchIds[0], user.id);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    const partial = response();
    await importRepairOrders({
      user, get: () => '', body: {
        fileName: 'partial-invalidation.csv',
        content: [
          'RO Number,VIN,Customer Name,Mobile,Make,Model,Total Labor Cost,Total Parts Cost,Visit Date',
          `${id}-new,${importedVin},New imported customer,9000000002,Hyundai,Test,100,50,2026-04-15`,
          `${id}-invalid,,Invalid customer,9000000003,Hyundai,Test,100,50,2026-04-15`,
        ].join('\n'),
      },
    }, partial);
    assert.equal(partial.statusCode, 201);
    importBatchIds.push(partial.body.batch.id);
    assert.ok(await prisma.workshopVisit.findFirst({ where: { ccmId: team, repairOrderNo: `${id}-new` } }));
    assert.ok(await prisma.importRowError.count({ where: { importBatchId: partial.body.batch.id } }) > 0);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    await rollbackImportBatch(partial.body.batch.id, user.id);
    assert.equal(await prisma.workshopVisit.count({ where: { ccmId: team, repairOrderNo: `${id}-new` } }), 0);
    const secondCustomer = await prisma.customer.create({ data: {
      customerCode: `${id}-delete`, fullName: 'Other imported customer', mobileNumber: '9000000001', ccmId: otherTeam,
    } });
    const secondPhysical = await prisma.physicalVehicle.create({ data: { vin: secondVin } });
    const secondVehicle = await prisma.vehicle.create({ data: {
      vin: secondVin, physicalVehicleId: secondPhysical.id, customerId: secondCustomer.id, ccmId: otherTeam,
    } });
    await prisma.freeServiceMilestone.deleteMany({ where: { vehicleId: vehicle.id } });
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    let milestoneBatch = 0;
    const partialMilestoneDb = {
      $transaction: (callback) => {
        milestoneBatch += 1;
        if (milestoneBatch === 1) return prisma.$transaction(callback);
        return prisma.$transaction((transaction) => callback(new Proxy(transaction, {
          get(target, property) {
            if (property === 'performanceSnapshotRevision') return { update: async () => { throw new Error('injected second batch failure'); } };
            return Reflect.get(target, property, target);
          },
        })));
      },
    };
    await assert.rejects(syncFreeServiceMilestones([
      ...Array.from({ length: 100 }, () => milestoneInput[0]),
      { id: secondVehicle.id, physicalVehicleId: secondPhysical.id, saleDate: new Date('2025-01-15T00:00:00Z'), workshopVisits: [] },
    ], partialMilestoneDb), /injected second batch failure/);
    assert.ok(await prisma.freeServiceMilestone.count({ where: { vehicleId: vehicle.id } }) > 0);
    assert.equal(await prisma.freeServiceMilestone.count({ where: { vehicleId: secondVehicle.id } }), 0);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    const secondImport = response();
    await importRepairOrders({
      user: otherUser, get: () => '', body: {
        fileName: 'invalidation-delete.csv',
        content: [
          'RO Number,VIN,Customer Name,Mobile,Make,Model,Total Labor Cost,Total Parts Cost,Visit Date',
          `${id}-delete,${secondVin},Other imported customer,9000000001,Hyundai,Test,100,50,2026-03-15`,
        ].join('\n'),
      },
    }, secondImport);
    assert.equal(secondImport.statusCode, 201);
    importBatchIds.push(secondImport.body.batch.id);
    const preview = await previewPermanentImportDeletion(importBatchIds[2]);
    assert.deepEqual(preview.blockers, []);
    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    await permanentlyDeleteImportBatch(importBatchIds[2], user.id, preview.confirmationToken);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');

    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    const transferKey = { ...key, creId: secondCre };
    await prisma.crePerformanceSnapshot.create({ data: { ...transferKey, status: 'ok', callsThisMonth: 13, computedAt: new Date() } });
    await prisma.performanceSnapshotRevision.createMany({ data: [{ scope: `ccm:${otherTeam}` }], skipDuplicates: true });
    const oldRevision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision;
    const newRevision = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${otherTeam}` } })).revision;
    let transferStarted;
    const enteredTransfer = new Promise((resolve) => { transferStarted = resolve; });
    const transferBlocked = new Promise((resolve) => { release = resolve; });
    pending = refreshSnapshot(transferKey, { compute: async () => {
      transferStarted();
      await transferBlocked;
      return { callsThisMonth: 99, details: {}, asOf: new Date() };
    } });
    await enteredTransfer;
    const transfer = response();
    await assignUserToCcm({ user, params: { id: secondCre }, body: { ccmId: otherTeam } }, transfer);
    assert.equal(transfer.statusCode, 200);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${team}` } })).revision, oldRevision + 1n);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${otherTeam}` } })).revision, newRevision + 1n);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
    release();
    assert.deepEqual(await pending, { refreshed: false, reason: 'superseded' });
    pending = null;
    assert.equal(await prisma.crePerformanceSnapshot.findUnique({ where: { creId_ccmId_year_month_viewer: transferKey } }), null);

    for (const body of [{ freeServiceEnabled: true }, { role: 'FREE_SERVICE_CRE' }]) {
      await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
      const before = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${otherTeam}` } })).revision;
      const account = response();
      await updateManagedUser({ user, params: { id: secondCre }, body }, account);
      assert.equal(account.statusCode, 200);
      assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: `ccm:${otherTeam}` } })).revision, before + 1n);
      assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
      assert.equal((await read()).status, 'ok');
    }

    await prisma.crePerformanceSnapshot.updateMany({ where: { ccmId: { in: [team, otherTeam] } }, data: { status: 'ok', dirtySince: null } });
    const beforeDeletion = (await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision;
    const deletion = response();
    await deleteManagedUser({ user, params: { id: secondCre } }, deletion);
    assert.equal(deletion.statusCode, 200);
    assert.equal((await prisma.performanceSnapshotRevision.findUniqueOrThrow({ where: { scope: 'global' } })).revision, beforeDeletion + 1n);
    assert.equal((await read()).status, 'dirty');
    assert.equal((await prisma.crePerformanceSnapshot.findFirstOrThrow({ where: { ccmId: otherTeam } })).status, 'dirty');
  } finally {
    if (pending) { release(); await pending; }
    if (importBatchIds.length) {
      await prisma.importRowError.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await prisma.importBatch.deleteMany({ where: { id: { in: importBatchIds } } });
    }
    await prisma.auditLog.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } });
    await prisma.appointmentEvent.deleteMany({ where: { appointment: { ccmId: team } } });
    await prisma.appointment.deleteMany({ where: { ccmId: team } });
    await prisma.followUp.deleteMany({ where: { ccmId: team } });
    await prisma.freeServiceMilestone.deleteMany({ where: { vehicleId: { in: (await prisma.vehicle.findMany({ where: { ccmId: { in: [team, otherTeam] } }, select: { id: true } })).map(({ id: vehicleId }) => vehicleId) } } });
    await prisma.monthlyCustomerDataEntry.deleteMany({ where: { dataset: { ccmId: team } } });
    await prisma.monthlyCustomerDataset.deleteMany({ where: { ccmId: team } });
    await prisma.creCallDaily.deleteMany({ where: { ccmId: team } });
    await prisma.creAssignmentHistory.deleteMany({ where: { ccmId: team } });
    await prisma.callLog.deleteMany({ where: { ccmId: team } });
    await prisma.masterCallList.deleteMany({ where: { ccmId: { in: [team, otherTeam] } } });
    await prisma.workshopVisit.deleteMany({ where: { ccmId: { in: [team, otherTeam] } } });
    await prisma.vehicle.deleteMany({ where: { ccmId: { in: [team, otherTeam] } } });
    await prisma.customer.deleteMany({ where: { ccmId: { in: [team, otherTeam] } } });
    await prisma.physicalVehicle.deleteMany({ where: { vin: { in: [vin, secondVin, customerVin, importedVin] } } });
    await prisma.crePerformanceSnapshot.deleteMany({ where: { ccmId: { in: [team, otherTeam] } } });
    await prisma.performanceSnapshotRevision.deleteMany({ where: { scope: { in: [`ccm:${team}`, `ccm:${otherTeam}`] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id, cre, secondCre] } } });
    await prisma.deletedUserIdentity.deleteMany({ where: { id: secondCre } });
    await prisma.$disconnect();
  }
});
