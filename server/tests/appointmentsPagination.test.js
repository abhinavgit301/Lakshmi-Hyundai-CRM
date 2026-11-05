import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { getAppointments } from '../src/controllers/recordsController.js';
import { appointmentVisibilityWhere } from '../src/utils/appointmentAccess.js';

function makeRes() {
  return {
    statusCode: 200,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const row = (id, scheduledAt) => ({
  id,
  customerId: 'c1',
  customerName: 'Snapshot Name',
  vehicleId: 'v1',
  vehicleName: 'Snapshot Vehicle',
  scheduledAt: new Date(scheduledAt),
  status: 'PENDING',
  confirmationCall: false,
  ccmId: 'ccm-a',
  assigneeId: null,
  assigneeNameSnapshot: 'Snap',
  customer: { fullName: 'Real Name' },
  vehicle: { model: 'i20' },
  assignee: null,
});

async function withAppointments(rows, fn) {
  const originalFind = prisma.appointment.findMany;
  const originalCount = prisma.appointment.count;
  const calls = { find: [], count: [] };
  prisma.appointment.findMany = async (args) => { calls.find.push(args); return rows; };
  prisma.appointment.count = async (args) => { calls.count.push(args); return rows.length + 5; };
  try {
    await fn(calls);
  } finally {
    prisma.appointment.findMany = originalFind;
    prisma.appointment.count = originalCount;
  }
}

const ccm = { id: 'u1', role: 'CCM', ccmId: 'ccm-a' };

test('unpaginated appointments keep the legacy shape and issue no count query', async () => {
  await withAppointments([row('a1', '2026-11-05T05:00:00Z')], async (calls) => {
    const res = makeRes();
    await getAppointments({ user: ccm, query: {} }, res);
    assert.equal(calls.count.length, 0);
    assert.equal(calls.find[0].skip, undefined);
    assert.equal(calls.find[0].take, undefined);
    assert.deepEqual(Object.keys(res.body), ['appointments']);
    assert.equal(res.body.appointments[0].customer, 'Real Name');
    assert.equal(res.body.appointments[0].vehicle, 'i20');
    assert.equal(res.body.appointments[0].assigneeName, 'Snap');
    assert.deepEqual(calls.find[0].orderBy, [{ scheduledAt: 'asc' }, { id: 'asc' }]);
  });
});

test('paginated appointments page in the database and report total and hasMore', async () => {
  await withAppointments([row('a1', '2026-11-05T05:00:00Z'), row('a2', '2026-11-05T06:00:00Z')], async (calls) => {
    const res = makeRes();
    await getAppointments({ user: ccm, query: { limit: '2', offset: '4' } }, res);
    assert.equal(calls.find[0].skip, 4);
    assert.equal(calls.find[0].take, 2);
    assert.equal(res.body.total, 7);
    assert.equal(res.body.hasMore, true);
    assert.equal(res.body.appointments.length, 2);
  });
});

test('filters only narrow the unchanged visibility scope', async () => {
  await withAppointments([], async (calls) => {
    await getAppointments({
      user: ccm,
      query: { limit: '10', from: '2026-11-01', to: '2026-11-08', status: 'no-show', search: 'KA01' },
    }, makeRes());
    const { where } = calls.find[0];
    assert.deepEqual(where.AND[0], appointmentVisibilityWhere(ccm));
    assert.ok(where.AND.some((clause) => clause.scheduledAt?.gte instanceof Date && clause.scheduledAt?.lt instanceof Date));
    assert.ok(where.AND.some((clause) => clause.status === 'NO_SHOW'));
    assert.ok(where.AND.some((clause) => Array.isArray(clause.OR)));
    assert.deepEqual(calls.count[0].where, where);
  });
});

test('CRE visibility is preserved when filters are applied', async () => {
  await withAppointments([], async (calls) => {
    await getAppointments({ user: { id: 'cre-1', role: 'CRE', ccmId: 'ccm-a' }, query: { limit: '5', search: 'x' } }, makeRes());
    const [visibility] = calls.find[0].where.AND;
    assert.ok(JSON.stringify(visibility).includes('cre-1'));
    assert.ok(JSON.stringify(visibility).includes('ccm-a'));
  });
});

test('invalid pagination, dates and status are rejected with 400 before any query', async () => {
  await withAppointments([], async (calls) => {
    for (const query of [{ limit: '0' }, { limit: '9999' }, { offset: '-1' }, { from: 'nope' }, { status: 'BOGUS' }]) {
      const res = makeRes();
      await getAppointments({ user: ccm, query }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(query));
    }
    assert.equal(calls.find.length, 0);
  });
});
