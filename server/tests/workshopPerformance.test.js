import test from 'node:test';
import assert from 'node:assert/strict';
import { queryWorkshopReportsData } from '../src/controllers/workshopPerformanceController.js';

function createReportDatabase({ users, calls = [], appointments = [], assigned = [] }) {
  return {
    user: {
      findMany: async () => users,
    },
    callLog: {
      findMany: async ({ where }) => calls.filter((call) => (
        where.createdById.in.includes(call.createdById)
        && call.createdAt >= where.createdAt.gte
        && call.createdAt < where.createdAt.lt
      )),
    },
    appointment: {
      findMany: async ({ where }) => appointments.filter((appointment) => (
        where.createdById.in.includes(appointment.createdById)
        && appointment.createdAt >= where.createdAt.gte
        && appointment.createdAt < where.createdAt.lt
      )),
    },
    masterCallList: {
      groupBy: async ({ where }) => assigned
        .filter((entry) => where.ownerUserId.in.includes(entry.ownerUserId))
        .map((entry) => ({ ownerUserId: entry.ownerUserId, _count: { _all: entry.count } })),
    },
  };
}

const reportUsers = [
  { id: 'ccm-1-user', name: 'Team One', role: 'CCM', ccmId: 'ccm-1' },
  { id: 'cre-1', name: 'CRE One', role: 'CRE', ccmId: 'ccm-1' },
  { id: 'cre-2', name: 'CRE Two', role: 'CRE', ccmId: 'ccm-1' },
  { id: 'ccm-2-user', name: 'Team Two', role: 'CCM', ccmId: 'ccm-2' },
  { id: 'cre-3', name: 'CRE Three', role: 'CRE', ccmId: 'ccm-2' },
];

const reportCalls = [
  { createdById: 'ccm-1-user', customerId: 'customer-1', outcome: 'CONTACTED', createdAt: new Date('2026-01-03T10:00:00Z') },
  { createdById: 'cre-1', customerId: 'customer-1', outcome: 'APPOINTMENT_SET', createdAt: new Date('2026-01-04T10:00:00Z') },
  { createdById: 'cre-2', customerId: 'customer-2', outcome: 'NO_RESPONSE', createdAt: new Date('2026-01-05T10:00:00Z') },
  { createdById: 'cre-2', customerId: 'customer-2', outcome: 'APPOINTMENT_SET', createdAt: new Date('2026-01-06T10:00:00Z') },
  { createdById: 'cre-3', customerId: 'customer-3', outcome: 'CONTACTED', createdAt: new Date('2026-01-07T10:00:00Z') },
];

const reportAppointments = [
  { createdById: 'ccm-1-user', createdAt: new Date('2026-01-03T10:00:00Z') },
  { createdById: 'cre-1', createdAt: new Date('2026-01-04T10:00:00Z') },
  { createdById: 'cre-2', createdAt: new Date('2026-01-06T10:00:00Z') },
  { createdById: 'cre-3', createdAt: new Date('2026-01-07T10:00:00Z') },
];

const reportAssigned = [
  { ownerUserId: 'ccm-1-user', count: 5 },
  { ownerUserId: 'cre-1', count: 2 },
  { ownerUserId: 'cre-2', count: 4 },
  { ownerUserId: 'cre-3', count: 3 },
];

function queryOptions(overrides = {}) {
  return { year: 2026, month: 1, tzOffset: 0, ...overrides };
}

test('whole CCM team report aggregates the CCM and its CREs once', async () => {
  const database = createReportDatabase({
    users: reportUsers,
    calls: reportCalls,
    appointments: reportAppointments,
    assigned: reportAssigned,
  });

  const report = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1' }), database);

  assert.equal(report.scope.type, 'ccm');
  assert.equal(report.scope.id, 'ccm-1');
  assert.deepEqual(report.totals, {
    calls: 4,
    customersReached: 2,
    appointmentsSet: 2,
    appointmentsBooked: 3,
    assignedRecords: 11,
    reachPercent: 18,
    conversionPercent: 75,
  });
  assert.deepEqual(report.breakdown.map(({ id }) => id).sort(), ['ccm-1-user', 'cre-1', 'cre-2']);
  assert.equal(report.daily.reduce((sum, day) => sum + day.calls, 0), 4);
});

test('individual CRE report only includes the CRE assigned to the selected CCM', async () => {
  const database = createReportDatabase({
    users: reportUsers,
    calls: reportCalls,
    appointments: reportAppointments,
    assigned: reportAssigned,
  });

  const report = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1', creId: 'cre-1' }), database);

  assert.equal(report.scope.type, 'cre');
  assert.equal(report.scope.id, 'cre-1');
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.customersReached, 1);
  assert.equal(report.totals.appointmentsBooked, 1);
  assert.equal(report.totals.assignedRecords, 2);

  const wrongTeamReport = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1', creId: 'cre-3' }), database);
  assert.equal(wrongTeamReport.error, 'CRE is not assigned to the selected CCM.');
});

test('whole-team report remains available when a CCM has no assigned CREs', async () => {
  const database = createReportDatabase({
    users: [reportUsers[0]],
    calls: [reportCalls[0]],
    appointments: [reportAppointments[0]],
    assigned: [reportAssigned[0]],
  });

  const report = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1' }), database);

  assert.equal(report.scope.type, 'ccm');
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.appointmentsBooked, 1);
  assert.deepEqual(report.breakdown.map(({ id }) => id), ['ccm-1-user']);
});
