import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { getCrePerformanceSummary, computeCrePerformanceMetrics } from '../src/controllers/callWorkflowController.js';
import { invalidateCallListCache } from '../src/utils/callListCache.js';

const MONTH = { year: 2026, month: 10, date: '2026-10-15' };
const CRE = {
  id: 'parity-cre',
  name: 'Parity CRE',
  role: 'CRE',
  ccmId: 'parity-ccm',
  freeServiceEnabled: false,
  warrantyEnabled: false,
  status: 'active',
};

function installFixture(t, { freeServiceEnabled = false, warrantyEnabled = false } = {}) {
  const source = [
    { id: 'call-service', customerId: 'customer-1', vehicleId: 'vehicle-1', callSource: 'SERVICE', outcome: 'APPOINTMENT_SET', createdAt: new Date('2026-10-12T08:00:00.000Z') },
    { id: 'call-free', customerId: 'customer-2', vehicleId: 'vehicle-2', callSource: 'FREE_SERVICE', outcome: 'COMPLETED', createdAt: new Date('2026-10-20T08:00:00.000Z') },
    { id: 'call-warranty', customerId: 'customer-3', vehicleId: 'vehicle-3', callSource: 'WARRANTY', outcome: 'NO_RESPONSE', createdAt: new Date('2026-10-22T08:00:00.000Z') },
    { id: 'call-historical', customerId: 'customer-1', vehicleId: 'vehicle-1', callSource: 'SERVICE', outcome: 'CONTACTED', createdAt: new Date('2026-09-15T08:00:00.000Z') },
    { id: 'call-other-owner', customerId: 'other-customer', vehicleId: 'other-vehicle', callSource: 'SERVICE', outcome: 'COMPLETED', createdAt: new Date('2026-10-23T08:00:00.000Z'), owned: false, assignedToId: 'other-cre' },
  ].map((call) => ({
    ...call,
    createdById: CRE.id,
    assignedToId: call.assignedToId || CRE.id,
    ccmId: CRE.ccmId,
    owned: call.owned !== false,
  }));
  const visit = (date, workType = 'Periodic Service') => ({
    id: `visit-${date}`,
    visitDate: new Date(`${date}T00:00:00.000Z`),
    closingDate: null,
    gpDate: null,
    ccmId: null,
    totalLaborCost: null,
    totalPartsCost: null,
    totalAmount: null,
    repairOrderNo: `RO-${date}`,
    importedDetails: { workType },
  });
  const records = [
    {
      id: 'entry-1y', createdAt: new Date('2026-10-01T00:00:00.000Z'), ccmId: CRE.ccmId, ownerUserId: CRE.id,
      customerName: 'Customer One', mobileNumber: '9999999991', vin: 'VIN-1', status: 'pending', registrationNumber: 'REG-1',
      vehicle: {
        id: 'vehicle-1', customerId: 'customer-1', model: 'Model A', saleDate: new Date('2024-10-15T00:00:00.000Z'),
        registrationNumber: 'REG-1', physicalVehicleId: null, physicalVehicle: { workshopVisits: [visit('2025-10-15')] },
        allocations: [{ serviceType: 'SERVICE' }], monthlyDataEntries: [{ serviceType: 'SERVICE', nextServiceDueDate: new Date('2026-10-01T00:00:00.000Z') }],
        appointments: [], customer: { appointments: [] },
      },
    },
    {
      id: 'entry-6m', createdAt: new Date('2026-10-02T00:00:00.000Z'), ccmId: CRE.ccmId, ownerUserId: CRE.id,
      customerName: 'Customer Two', mobileNumber: '9999999992', vin: 'VIN-2', status: 'pending', registrationNumber: 'REG-2',
      vehicle: {
        id: 'vehicle-2', customerId: 'customer-2', model: 'Model B', saleDate: new Date('2024-04-15T00:00:00.000Z'),
        registrationNumber: 'REG-2', physicalVehicleId: null, physicalVehicle: { workshopVisits: [visit('2026-04-15')] },
        allocations: [{ serviceType: 'FREE_SERVICE' }], monthlyDataEntries: [{ serviceType: 'FREE_SERVICE', nextServiceDueDate: new Date('2026-10-01T00:00:00.000Z') }],
        appointments: [], customer: { appointments: [] },
      },
    },
    {
      id: 'entry-warranty', createdAt: new Date('2026-10-03T00:00:00.000Z'), ccmId: CRE.ccmId, ownerUserId: CRE.id,
      customerName: 'Customer Three', mobileNumber: '9999999993', vin: 'VIN-3', status: 'pending', registrationNumber: 'REG-3',
      vehicle: {
        id: 'vehicle-3', customerId: 'customer-3', model: 'Model C', saleDate: new Date('2023-10-15T00:00:00.000Z'),
        registrationNumber: 'REG-3', physicalVehicleId: null, physicalVehicle: { workshopVisits: [] },
        allocations: [{ serviceType: 'WARRANTY' }], monthlyDataEntries: [{ serviceType: 'WARRANTY', nextServiceDueDate: null }],
        appointments: [], customer: { appointments: [] },
      },
    },
    {
      id: 'entry-other-owner', createdAt: new Date('2026-10-04T00:00:00.000Z'), ccmId: CRE.ccmId, ownerUserId: 'other-cre',
      customerName: 'Other Customer', mobileNumber: '9999999994', vin: 'VIN-4', status: 'pending', registrationNumber: 'REG-4',
      vehicle: {
        id: 'other-vehicle', customerId: 'other-customer', model: 'Model D', saleDate: new Date('2024-10-15T00:00:00.000Z'),
        registrationNumber: 'REG-4', physicalVehicleId: null, physicalVehicle: { workshopVisits: [visit('2025-10-15')] },
        allocations: [{ serviceType: 'SERVICE' }], monthlyDataEntries: [{ serviceType: 'SERVICE', nextServiceDueDate: new Date('2026-10-01T00:00:00.000Z') }],
        appointments: [], customer: { appointments: [] },
      },
    },
  ];
  const appointments = [
    { id: 'appointment-1', ccmId: CRE.ccmId, assigneeId: CRE.id, customerId: 'customer-1', vehicleId: 'vehicle-1' },
    { id: 'appointment-other', ccmId: CRE.ccmId, assigneeId: 'other-cre', customerId: 'other-customer', vehicleId: 'other-vehicle' },
  ];
  const followUps = [
    { id: 'follow-up-1', ccmId: CRE.ccmId, creId: CRE.id, customerId: 'customer-1', vehicleId: 'vehicle-1', status: 'pending', owned: true },
    { id: 'follow-up-other', ccmId: CRE.ccmId, creId: 'other-cre', customerId: 'other-customer', vehicleId: 'other-vehicle', status: 'pending', owned: false },
  ];
  const targetCre = { ...CRE, freeServiceEnabled, warrantyEnabled };

  function matchesCall(call, where) {
    if (typeof where.createdById === 'string' && call.createdById !== where.createdById) return false;
    if (where.createdById?.in && !where.createdById.in.includes(call.createdById)) return false;
    if (where.ccmId && call.ccmId !== where.ccmId) return false;
    const source = where.callSource;
    if (typeof source === 'string' && call.callSource !== source) return false;
    if (source?.in && !source.in.includes(call.callSource)) return false;
    if (source?.not && source.not === call.callSource) return false;
    if (where.outcome && where.outcome !== call.outcome) return false;
    if (where.createdAt?.gte && call.createdAt < where.createdAt.gte) return false;
    if (where.createdAt?.lt && call.createdAt >= where.createdAt.lt) return false;
    if (where.assignedToId && call.assignedToId !== where.assignedToId) return false;
    if (where.vehicleId?.in && !where.vehicleId.in.includes(call.vehicleId)) return false;
    if (where.customerId?.in && !where.customerId.in.includes(call.customerId)) return false;
    if (JSON.stringify(where).includes('masterCallListEntries') && !call.owned) return false;
    return true;
  }

  const delegates = {
    user: {
      findFirst: async () => targetCre,
      findMany: async () => [],
    },
    monthlyCustomerDataImport: {
      findFirst: async () => ({ createdAt: new Date('2026-10-08T00:00:00.000Z') }),
    },
    masterCallList: {
      findMany: async ({ where }) => records.filter((record) => (
        record.ccmId === where.ccmId
        && (record.ownerUserId === CRE.id || record.vehicle.allocations.some((allocation) => allocation.creId === CRE.id))
      )),
    },
    callLog: {
      count: async ({ where }) => source.filter((call) => matchesCall(call, where)).length,
      groupBy: async ({ by, where }) => {
        const grouped = new Map();
        for (const call of source.filter((entry) => matchesCall(entry, where))) {
          const key = by.map((field) => call[field]).join('|');
          const group = grouped.get(key) || Object.fromEntries(by.map((field) => [field, call[field]]));
          group._count = { _all: (group._count?._all || 0) + 1 };
          grouped.set(key, group);
        }
        return [...grouped.values()];
      },
      findMany: async ({ where }) => source.filter((call) => matchesCall(call, where)),
    },
    followUp: {
      count: async ({ where }) => followUps.filter((followUp) => (
        followUp.status === where.status
        && followUp.ccmId === where.ccmId
        && (!where.creId || followUp.creId === where.creId)
        && (!JSON.stringify(where).includes('masterCallListEntries') || followUp.owned)
      )).length,
    },
    appointment: {
      count: async ({ where }) => appointments.filter((appointment) => (
        appointment.ccmId === where.ccmId
        && (!where.OR || where.OR.some((branch) => branch.assigneeId === appointment.assigneeId || branch.createdById === appointment.assigneeId))
      )).length,
    },
    vehicle: {
      findMany: async () => [{
        id: 'vehicle-3',
        vin: 'VIN-3',
        registrationNumber: 'REG-3',
        saleDate: new Date('2023-10-15T00:00:00.000Z'),
        customerId: 'customer-3',
        customer: { fullName: 'Customer Three' },
      }],
    },
  };
  const originals = [];
  for (const [delegateName, methods] of Object.entries(delegates)) {
    for (const [method, implementation] of Object.entries(methods)) {
      const delegate = prisma[delegateName];
      originals.push({ delegate, method, value: delegate[method] });
      delegate[method] = implementation;
    }
  }
  t.after(() => originals.forEach(({ delegate, method, value }) => { delegate[method] = value; }));
  return { targetCre };
}

function comparable(metrics) {
  return {
    callsThisMonth: metrics.callsThisMonth,
    assignedCustomerCount: metrics.assignedCustomerCount,
    pendingFollowUps: metrics.pendingFollowUps,
    dueServicesCount: metrics.dueServicesCount,
    missedWarrantyCount: metrics.missedWarrantyCount,
    cycleStartedAt: metrics.cycleStartedAt,
    ...metrics.details,
  };
}

async function getLegacyMetrics(t, scenario, viewerRole) {
  installFixture(t, scenario);
  invalidateCallListCache({ kinds: ['workflow'] });
  let response;
  const req = {
    method: 'GET',
    user: viewerRole === 'CCM'
      ? { id: 'parity-ccm-user', name: 'Parity CCM', role: 'CCM', ccmId: CRE.ccmId }
      : { ...CRE, ...scenario },
    query: { ...MONTH, date: MONTH.date, range: 'month', ...(viewerRole === 'CCM' ? { creId: CRE.id } : {}) },
  };
  await getCrePerformanceSummary(req, {
    status(code) { this.statusCode = code; return this; },
    json(body) { response = body; return this; },
  });
  assert.ok(response, 'legacy performance endpoint returned no response');
  return response;
}

test('snapshot metrics match the legacy live endpoint across permissions, ownership and historical periods', async (t) => {
  const originalDate = globalThis.Date;
  const fixedNow = new originalDate('2026-11-06T08:30:00.000Z');
  globalThis.Date = class FixedDate extends originalDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow.getTime(); }
  };
  const originalEnabled = process.env.PERFORMANCE_AGGREGATES_ENABLED;
  process.env.PERFORMANCE_AGGREGATES_ENABLED = 'false';
  t.after(() => {
    globalThis.Date = originalDate;
    if (originalEnabled === undefined) delete process.env.PERFORMANCE_AGGREGATES_ENABLED;
    else process.env.PERFORMANCE_AGGREGATES_ENABLED = originalEnabled;
  });

  const scenarios = [
    { name: 'ordinary CRE', permissions: { freeServiceEnabled: false, warrantyEnabled: false }, viewer: 'CRE', role: 'CRE' },
    { name: 'Free-Service-enabled CRE', permissions: { freeServiceEnabled: true, warrantyEnabled: false }, viewer: 'CRE', role: 'CRE' },
    { name: 'warranty-enabled CRE', permissions: { freeServiceEnabled: false, warrantyEnabled: true }, viewer: 'CRE', role: 'CRE' },
    { name: 'CCM visibility', permissions: { freeServiceEnabled: false, warrantyEnabled: false }, viewer: 'CCM', role: 'CCM' },
  ];
  const mismatches = [];
  for (const scenario of scenarios) {
    const fixture = { ...scenario.permissions };
    const live = await getLegacyMetrics(t, fixture, scenario.role);
    const { targetCre } = installFixture(t, fixture);
    const snapshot = await computeCrePerformanceMetrics({
      targetCre,
      viewer: scenario.viewer,
      year: MONTH.year,
      month: MONTH.month,
      now: fixedNow,
    });
    const expected = comparable(live);
    const actual = comparable(snapshot);
    for (const metric of Object.keys(expected)) {
      if (JSON.stringify(expected[metric]) !== JSON.stringify(actual[metric])) {
        mismatches.push({ scenario: scenario.name, metric, live: expected[metric], snapshot: actual[metric] });
      }
    }
  }
  assert.deepEqual(mismatches, [], `Snapshot/live metric mismatches:\n${JSON.stringify(mismatches, null, 2)}`);
});
