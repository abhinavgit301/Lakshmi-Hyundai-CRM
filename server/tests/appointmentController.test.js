import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { deleteAppointment } from '../src/controllers/appointmentController.js';

after(async () => {
  await prisma.$disconnect();
});

function responseRecorder() {
  return {
    body: undefined,
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function replaceMethod(t, target, methodName, implementation) {
  const original = target[methodName];
  target[methodName] = implementation;
  t.after(() => {
    target[methodName] = original;
  });
}

test('appointment removal retains the appointment and appends a deletion event', async (t) => {
  const appointment = { id: 'appointment-1', status: 'CONFIRMED' };
  const events = [{ id: 'created-event', eventType: 'CREATED' }];
  let updatedAppointment;
  replaceMethod(t, prisma.appointment, 'findFirst', async () => appointment);
  replaceMethod(t, prisma, '$transaction', async (callback) => callback({
    appointment: {
      update: async ({ where, data }) => {
        assert.equal(where.id, appointment.id);
        updatedAppointment = { ...appointment, ...data };
        return updatedAppointment;
      },
    },
    appointmentEvent: {
      findFirst: async () => null,
      create: async ({ data }) => {
        events.push(data);
        return data;
      },
    },
  }));
  const response = responseRecorder();

  await deleteAppointment({
    params: { id: appointment.id },
    user: { id: 'ccm-1', name: 'CCM User', role: 'CCM', ccmId: 'ccm-1' },
  }, response);

  assert.deepEqual(response.body, { id: appointment.id });
  assert.equal(updatedAppointment.status, 'CANCELLED');
  assert.deepEqual(events, [
    { id: 'created-event', eventType: 'CREATED' },
    {
      appointmentId: appointment.id,
      eventType: 'DELETED',
      notes: 'Appointment removed by CCM User.',
    },
  ]);
});
