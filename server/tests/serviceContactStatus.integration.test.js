import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.STATUS_INTEGRATION_DATABASE_URL;

test('service actions and appointment retries are transactional', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/status_test_/);
  process.env.DATABASE_URL = databaseUrl;
  process.env.SERVICE_CONTACT_STATUS_ENABLED = 'true';
  const { prisma } = await import('../src/config/prisma.js');
  const { createCallLog, createFollowUp, updateFollowUpStatus } = await import('../src/controllers/callWorkflowController.js');
  const { createAppointment, deleteAppointment } = await import('../src/controllers/appointmentController.js');
  const { getCallList, getDueCallList } = await import('../src/controllers/recordsController.js');
  const { invalidateCallListCache } = await import('../src/utils/callListCache.js');
  const id = randomUUID();
  const user = await prisma.user.create({ data: { name: 'Test CCM', password: 'test', role: 'CCM', ccmId: id } });
  const customer = await prisma.customer.create({ data: { customerCode: id, fullName: 'Test customer', ccmId: id } });
  const physical = await prisma.physicalVehicle.create({ data: { vin: id } });
  const vehicle = await prisma.vehicle.create({
    data: { vin: id, physicalVehicleId: physical.id, customerId: customer.id, ccmId: id },
  });
  const now = new Date();
  await prisma.workshopVisit.create({
    data: {
      repairOrderNo: id, normalizedRepairOrderNo: id, customerId: customer.id,
      vehicleId: vehicle.id, physicalVehicleId: physical.id, ccmId: id,
      visitDate: new Date(now.getFullYear(), now.getMonth() - 6, 5),
      importedDetails: { workType: 'Paid Service' },
    },
  });
  await prisma.physicalVehicle.update({
    where: { id: physical.id },
    data: { lastServiceDate: new Date(now.getFullYear(), now.getMonth() - 6, 5) },
  });
  await prisma.masterCallList.create({
    data: { customerName: customer.fullName, mobileNumber: '0000000000', vin: id, ccmId: id, vehicleId: vehicle.id },
  });
  const response = () => ({
    locals: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const state = () => prisma.vehicle.findUnique({ where: { id: vehicle.id } });
  const call = async (outcome, extra = {}) => {
    const res = response();
    await createCallLog({ user, body: { customerId: customer.id, vehicleId: vehicle.id, callSource: 'SERVICE', outcome, ...extra } }, res);
    assert.equal(res.statusCode, 201);
    return res;
  };
  try {
    const contacted = await call('CONTACTED');
    assert.deepEqual(contacted.locals.cacheInvalidation, { ccmIds: [id], kinds: undefined });
    assert.equal((await state()).serviceContactStatus, 'contacted');
    await call('NO_RESPONSE');
    assert.equal((await state()).serviceContactStatus, 'contacted');
    await call('FOLLOW_UP_LATER', { followUpAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal((await state()).serviceContactStatus, 'follow-up');
    const appointmentCall = await call('APPOINTMENT_SET');
    assert.equal((await state()).serviceContactStatus, 'follow-up');
    const body = {
      customerId: customer.id, vehicleId: vehicle.id,
      serviceCallId: appointmentCall.body.callLog.id,
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const invalid = response();
    await createAppointment({ user, body: { ...body, serviceCallId: contacted.body.callLog.id } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal((await state()).serviceContactStatus, 'follow-up');
    const wrongActor = response();
    await createAppointment({ user: { ...user, id: randomUUID() }, body }, wrongActor);
    assert.equal(wrongActor.statusCode, 400);
    const wrongTeam = response();
    await createAppointment({ user: { ...user, ccmId: randomUUID() }, body }, wrongTeam);
    assert.equal(wrongTeam.statusCode, 404);
    const first = response();
    await createAppointment({ user, body }, first);
    assert.equal(first.statusCode, 201);
    assert.equal((await state()).serviceContactStatus, 'appointment');
    const retry = response();
    await createAppointment({ user, body }, retry);
    assert.equal(retry.statusCode, 201);
    assert.equal(retry.body.appointment.id, first.body.appointment.id);
    const conflict = response();
    await createAppointment({ user, body: { ...body, scheduledAt: new Date(Date.now() + 172800000).toISOString() } }, conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(await prisma.appointment.count({ where: { serviceRequestId: body.serviceCallId } }), 1);
    invalidateCallListCache();
    const master = response();
    await getCallList({ user, query: {} }, master);
    const due = response();
    await getDueCallList({ user, query: { window: '6m', limit: '50', offset: '0' } }, due);
    assert.equal(master.body.records.find((row) => row.vehicleId === vehicle.id)?.status, 'appointment');
    assert.equal(due.body.records.find((row) => row.vehicleId === vehicle.id)?.status, 'appointment');

    const orderTeam = `${id}-ordering`;
    const orderUser = { ...user, ccmId: orderTeam };
    const cohort = `6m:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const entries = [['pending', 50], ['contacted', 7], ['follow-up', 10], ['appointment', 6]]
      .flatMap(([status, count]) => Array.from({ length: count }, (_, n) => ({
        key: `${orderTeam}-${status}-${n}`, status,
      })));
    await prisma.customer.createMany({ data: entries.map(({ key }) => ({ id: key, customerCode: key, fullName: key, ccmId: orderTeam })) });
    await prisma.physicalVehicle.createMany({ data: entries.map(({ key }) => ({
      id: key, vin: key, lastServiceDate: new Date(now.getFullYear(), now.getMonth() - 6, 5),
    })) });
    await prisma.vehicle.createMany({ data: entries.map(({ key, status }) => ({
      id: key, vin: key, customerId: key, physicalVehicleId: key, ccmId: orderTeam,
      serviceContactStatus: status, serviceStatusCohort: cohort,
    })) });
    await prisma.workshopVisit.createMany({ data: entries.map(({ key }) => ({
      repairOrderNo: key, normalizedRepairOrderNo: key, customerId: key, vehicleId: key,
      physicalVehicleId: key, ccmId: orderTeam, visitDate: new Date(now.getFullYear(), now.getMonth() - 6, 5),
      importedDetails: { workType: 'Paid Service' },
    })) });
    await prisma.masterCallList.createMany({ data: entries.map(({ key }) => ({
      customerName: key, mobileNumber: '0000000000', vin: key, ccmId: orderTeam, vehicleId: key,
    })) });
    const firstPage = response();
    await getDueCallList({ user: orderUser, query: { window: '6m', limit: '50', offset: '0' } }, firstPage);
    assert.equal(firstPage.body.total, 73);
    assert.ok(firstPage.body.records.every((record) => record.status === 'pending'));
    const offsetPage = response();
    await getDueCallList({ user: orderUser, query: { window: '6m', limit: '50', offset: '50' } }, offsetPage);
    const cursorPage = response();
    await getDueCallList({ user: orderUser, query: { window: '6m', limit: '50', cursor: firstPage.body.nextCursor } }, cursorPage);
    assert.deepEqual(cursorPage.body.records.map((record) => record.id), offsetPage.body.records.map((record) => record.id));
    assert.deepEqual(offsetPage.body.records.map((record) => record.status), [
      ...Array(7).fill('contacted'), ...Array(10).fill('follow-up'), ...Array(6).fill('appointment'),
    ]);

    const cancelledAppointment = response();
    await deleteAppointment({ user, params: { id: first.body.appointment.id } }, cancelledAppointment);
    assert.equal(cancelledAppointment.statusCode, 200);
    assert.equal((await state()).serviceContactStatus, 'appointment');
    const followUp = response();
    await createFollowUp({ user, body: {
      customerId: customer.id, vehicleId: vehicle.id, source: 'SERVICE',
      category: 'FOLLOW_UP_LATER', followUpAt: new Date(Date.now() + 172800000).toISOString(),
    } }, followUp);
    assert.equal(followUp.statusCode, 201);
    assert.equal((await state()).serviceContactStatus, 'follow-up');
    const completedFollowUp = response();
    await updateFollowUpStatus({ user, params: { id: followUp.body.followUp.id }, body: { status: 'completed' } }, completedFollowUp);
    assert.equal(completedFollowUp.statusCode, 200);
    assert.equal((await state()).serviceContactStatus, 'follow-up');

    process.env.SERVICE_CONTACT_STATUS_ENABLED = 'false';
    const disabledCall = await call('APPOINTMENT_SET');
    const disabledBody = { ...body, serviceCallId: disabledCall.body.callLog.id };
    const disabledFirst = response();
    await createAppointment({ user, body: disabledBody }, disabledFirst);
    const disabledRetry = response();
    await createAppointment({ user, body: disabledBody }, disabledRetry);
    assert.equal(disabledRetry.body.appointment.id, disabledFirst.body.appointment.id);
    assert.equal((await state()).serviceContactStatus, 'follow-up');
  } finally {
    await prisma.$disconnect();
  }
});
