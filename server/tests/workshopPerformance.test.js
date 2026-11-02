import test from 'node:test';
import assert from 'node:assert/strict';
import { queryWorkshopReportsData } from '../src/controllers/workshopPerformanceController.js';

function createReportDatabase({ users, calls = [], appointments = [], assigned = [], masterCallListEntries = [] }) {
  const masterCallListQueries = [];
  return {
    user: {
      findMany: async () => users,
    },
    deletedUserIdentity: {
      findMany: async () => [],
    },
    callLog: {
      findMany: async ({ where }) => calls.filter((call) => (
        where.OR.some((condition) => (
          condition.createdById?.in.includes(call.createdById || call.createdByIdSnapshot)
          || condition.createdByIdSnapshot?.in.includes(call.createdById || call.createdByIdSnapshot)
        ))
        && call.createdAt >= where.createdAt.gte
        && call.createdAt < where.createdAt.lt
      )),
    },
    appointment: {
      findMany: async ({ where }) => appointments.filter((appointment) => (
        where.OR.some((condition) => (
          condition.createdById?.in.includes(appointment.createdById || appointment.createdByIdSnapshot)
          || condition.createdByIdSnapshot?.in.includes(appointment.createdById || appointment.createdByIdSnapshot)
        ))
        && appointment.createdAt >= where.createdAt.gte
        && appointment.createdAt < where.createdAt.lt
      )),
    },
    masterCallList: {
      groupBy: async ({ where }) => assigned
        .filter((entry) => where.ownerUserId.in.includes(entry.ownerUserId))
        .map((entry) => ({ ownerUserId: entry.ownerUserId, _count: { _all: entry.count } })),
      findMany: async ({ where, orderBy, take, skip = 0, cursor }) => {
        masterCallListQueries.push({ where, take });
        let rows = masterCallListEntries.filter((entry) => where.ccmId.in.includes(entry.ccmId));
        if (orderBy?.id) rows = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        if (cursor) rows = rows.slice(rows.findIndex((entry) => entry.id === cursor.id) + skip);
        return take ? rows.slice(0, take) : rows;
      },
    },
    masterCallListQueries,
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
  return { year: 2026, month: 1, tzOffset: 0, now: new Date('2026-12-15T12:00:00Z'), ...overrides };
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
    dueCustomers: 0,
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
  assert.equal(report.totals.dueCustomers, 0);

  const wrongTeamReport = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1', creId: 'cre-3' }), database);
  assert.equal(wrongTeamReport.error, 'CRE is not assigned to the selected CCM.');
});

test('due-customer totals count canonical CRE-owned 6-month and 1-year Master Call List records', async () => {
  const visit = (date) => ({ visitDate: new Date(`${date}T12:00:00Z`) });
  const masterCallListEntries = [
    { id: 'mcl-cre1-1y', ccmId: 'ccm-1', vin: 'VIN-1', ownerUserId: 'cre-1', createdAt: new Date('2026-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2025-12-01')] } } },
    { id: 'mcl-cre2-6m', ccmId: 'ccm-1', vin: 'VIN-2', ownerUserId: 'cre-2', createdAt: new Date('2026-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2026-06-01')] } } },
    { id: 'mcl-cre2-not-due', ccmId: 'ccm-1', vin: 'VIN-3', ownerUserId: 'cre-2', createdAt: new Date('2026-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2026-11-01')] } } },
    { id: 'mcl-ccm-due', ccmId: 'ccm-1', vin: 'VIN-4', ownerUserId: 'ccm-1-user', createdAt: new Date('2026-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2025-12-01')] } } },
    { id: 'mcl-unassigned-due', ccmId: 'ccm-1', vin: 'VIN-5', ownerUserId: null, createdAt: new Date('2026-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2025-12-01')] } } },
    { id: 'mcl-duplicate-unassigned', ccmId: 'ccm-1', vin: 'VIN-1', ownerUserId: null, createdAt: new Date('2025-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2025-12-01')] } } },
    { id: 'mcl-other-team', ccmId: 'ccm-2', vin: 'VIN-6', ownerUserId: 'cre-3', createdAt: new Date('2026-01-01'), vehicle: { physicalVehicle: { workshopVisits: [visit('2025-12-01')] } } },
  ];
  const database = createReportDatabase({ users: reportUsers, masterCallListEntries });

  const teamReport = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1' }), database);

  assert.equal(teamReport.totals.dueCustomers, 2);
  assert.equal(teamReport.breakdown.find(({ id }) => id === 'cre-1').dueCustomers, 1);
  assert.equal(teamReport.breakdown.find(({ id }) => id === 'cre-2').dueCustomers, 1);
  assert.equal(teamReport.breakdown.find(({ id }) => id === 'ccm-1-user').dueCustomers, 0);

  const creReport = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1', creId: 'cre-1' }), database);
  assert.equal(creReport.totals.dueCustomers, 1);
});

test('master call list is read in bounded pages without losing or duplicating due customers', async () => {
  const visit = { visitDate: new Date('2025-12-01T12:00:00Z') };
  const total = 25000;
  const masterCallListEntries = Array.from({ length: total }, (_, index) => ({
    id: `mcl-${String(index).padStart(5, '0')}`,
    ccmId: 'ccm-1',
    vin: `VIN-${index}`,
    ownerUserId: 'cre-1',
    createdAt: new Date('2026-01-01'),
    vehicle: { physicalVehicle: { workshopVisits: [visit] } },
  }));
  const database = createReportDatabase({ users: reportUsers, masterCallListEntries });

  const report = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1' }), database);

  assert.equal(report.totals.dueCustomers, total);
  assert.ok(database.masterCallListQueries.length >= 3);
  assert.ok(database.masterCallListQueries.every(({ take }) => take > 0 && take <= 20000));
  assert.ok(database.masterCallListQueries.every(({ where }) => where.ccmId.in.join() === 'ccm-1'));

  const empty = await queryWorkshopReportsData(
    queryOptions({ ccmId: 'ccm-1' }),
    createReportDatabase({ users: reportUsers, masterCallListEntries: [] }),
  );
  assert.equal(empty.totals.dueCustomers, 0);
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

test('whole-team report retains historical activity for an archived CRE identity', async () => {
  const archivedCre = { id: 'deleted-cre', name: 'Former CRE', role: 'CRE', ccmId: 'ccm-1' };
  const database = createReportDatabase({
    users: [reportUsers[0]],
    calls: [{
      createdById: null,
      createdByIdSnapshot: archivedCre.id,
      customerId: 'customer-archived',
      outcome: 'APPOINTMENT_SET',
      createdAt: new Date('2026-01-03T10:00:00Z'),
    }],
    appointments: [{
      createdById: null,
      createdByIdSnapshot: archivedCre.id,
      createdAt: new Date('2026-01-03T10:00:00Z'),
    }],
    assigned: [],
  });
  database.deletedUserIdentity.findMany = async () => [archivedCre];

  const report = await queryWorkshopReportsData(queryOptions({ ccmId: 'ccm-1' }), database);

  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.appointmentsBooked, 1);
  assert.ok(report.breakdown.some(({ id, name }) => id === archivedCre.id && name === archivedCre.name));
});
