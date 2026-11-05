import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import { getCallList, getVisibilityWhere } from '../src/controllers/recordsController.js';

// Behavioural contract of the paginated Master Call List (GET /call-list), recorded against the current in-memory
// implementation so that a SQL-backed replacement can be held to exactly the same observable behaviour.
// Prisma is stubbed; nothing touches a database.

let sequence = 0;

function makeRow(id, vin, overrides = {}) {
  return {
    id,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ccmId: 'ccm-a',
    ownerUserId: null,
    customerName: `Customer ${id}`,
    mobileNumber: '',
    vin,
    status: 'pending',
    registrationNumber: null,
    vehicle: null,
    ...overrides,
  };
}

function makeAllocation(id, vin, overrides = {}) {
  const { vehicle, ...rest } = overrides;
  return {
    id,
    ccmId: 'ccm-a',
    serviceType: 'Paid',
    vehicle: vin === null ? null : { id: `vehicle-${id}`, vin, model: 'Model', registrationNumber: null, customer: null, ...vehicle },
    ...rest,
  };
}

function makeVehicle(id, visits, extra = {}) {
  return {
    id,
    customerId: `customer-${id}`,
    model: 'Model',
    saleDate: null,
    registrationNumber: null,
    physicalVehicleId: `physical-${id}`,
    physicalVehicle: { workshopVisits: visits },
    allocations: [],
    monthlyDataEntries: [],
    appointments: [],
    customer: { appointments: [] },
    ...extra,
  };
}

async function requestCallList({ user, query = {}, rows = [], allocations = [], teams = [] }) {
  const original = {
    master: prisma.masterCallList.findMany,
    user: prisma.user.findMany,
    allocation: prisma.allocation.findMany,
  };
  const calls = { master: [], allocation: [] };
  prisma.masterCallList.findMany = async (args) => { calls.master.push(args); return rows.slice(0, args.take); };
  prisma.user.findMany = async (args) => (args?.where?.role === 'CCM' ? teams : []);
  prisma.allocation.findMany = async (args) => { calls.allocation.push(args); return allocations; };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    // A unique user id keeps the response cache from serving an earlier test's result.
    await getCallList({ user: { id: `contract-user-${++sequence}`, ...user }, query }, res);
    return { status: res.statusCode, body: res.body, calls };
  } finally {
    prisma.masterCallList.findMany = original.master;
    prisma.user.findMany = original.user;
    prisma.allocation.findMany = original.allocation;
  }
}

const ids = (response) => response.body.records.map((record) => record.id);

test('canonical (ccmId, vin) selection prefers an owner, then the earliest createdAt, then the lowest id; shared VINs stay per CCM', async () => {
  const rows = [
    makeRow('m-c', 'VIN-1', { ownerUserId: 'cre-1', createdAt: new Date('2026-01-10T00:00:00Z') }),
    makeRow('m-b', 'VIN-1', { ownerUserId: null, createdAt: new Date('2026-01-01T00:00:00Z') }),
    makeRow('m-a', 'VIN-1', { ownerUserId: 'cre-2', createdAt: new Date('2026-01-10T00:00:00Z') }),
    makeRow('m-empty-owner', 'VIN-2', { ownerUserId: '', createdAt: new Date('2026-01-02T00:00:00Z') }),
    makeRow('m-real-owner', 'VIN-2', { ownerUserId: 'cre-1', createdAt: new Date('2026-01-09T00:00:00Z') }),
    makeRow('m-tie-b', 'VIN-3', { createdAt: new Date('2026-01-05T00:00:00Z') }),
    makeRow('m-tie-a', 'VIN-3', { createdAt: new Date('2026-01-05T00:00:00Z') }),
    makeRow('m-other-ccm', 'VIN-1', { ccmId: 'ccm-b', createdAt: new Date('2026-01-20T00:00:00Z') }),
  ];
  const response = await requestCallList({ user: { role: 'ADMIN' }, rows });

  assert.equal(response.body.total, 4);
  assert.deepEqual(ids(response), ['m-other-ccm', 'm-a', 'm-real-owner', 'm-tie-a']);
});

test('ordering is createdAt descending, ties by id, missing createdAt last; page boundaries do not change the total', async () => {
  const same = new Date('2026-02-01T00:00:00Z');
  const rows = [
    makeRow('b', 'VIN-B', { createdAt: same }),
    makeRow('a', 'VIN-A', { createdAt: same }),
    makeRow('c', 'VIN-C', { createdAt: same }),
    makeRow('newest', 'VIN-N', { createdAt: new Date('2026-03-01T00:00:00Z') }),
    makeRow('undated', 'VIN-U', { createdAt: null }),
  ];
  const first = await requestCallList({ user: { role: 'ADMIN' }, rows, query: { limit: '2', offset: '0' } });
  const second = await requestCallList({ user: { role: 'ADMIN' }, rows, query: { limit: '2', offset: '2' } });
  const third = await requestCallList({ user: { role: 'ADMIN' }, rows, query: { limit: '2', offset: '4' } });
  const beyond = await requestCallList({ user: { role: 'ADMIN' }, rows, query: { limit: '2', offset: '40' } });

  assert.deepEqual(ids(first), ['newest', 'a']);
  assert.deepEqual(ids(second), ['b', 'c']);
  assert.deepEqual(ids(third), ['undated']);
  assert.deepEqual([first, second, third].map((r) => r.body.hasMore), [true, true, false]);
  assert.deepEqual([first, second, third, beyond].map((r) => r.body.total), [5, 5, 5, 5]);
  assert.deepEqual(ids(beyond), []);
  assert.equal(beyond.body.hasMore, false);
});

test('CCM allocation queue: entries follow master rows ordered by id, honour filters, and never duplicate a master VIN', async () => {
  const rows = [
    makeRow('m-owned', 'VIN-A', { ownerUserId: 'cre-1', customerName: 'Alice', createdAt: new Date('2026-01-05T00:00:00Z') }),
    makeRow('m-unowned', 'VIN-U', { customerName: 'Una', createdAt: new Date('2026-01-04T00:00:00Z') }),
  ];
  const allocations = [
    makeAllocation('al-u', 'VIN-U', { serviceType: 'Paid' }),
    makeAllocation('al-q2', 'VIN-Q2', { serviceType: 'Free', vehicle: { registrationNumber: 'KA02Q2' } }),
    makeAllocation('al-q1b', 'VIN-Q1', { serviceType: 'PMS', vehicle: { registrationNumber: 'KA01Q1' } }),
    makeAllocation('al-q1a', 'VIN-Q1', { serviceType: 'Paid', vehicle: { registrationNumber: 'KA01Q1' } }),
    makeAllocation('al-other-ccm', 'VIN-B', { ccmId: 'ccm-b' }),
    makeAllocation('al-empty-vin', ''),
    makeAllocation('al-no-vehicle', null),
  ];
  const user = { role: 'CCM', ccmId: 'ccm-a' };
  const run = (query) => requestCallList({ user, rows, allocations, query });

  const all = await run({});
  assert.deepEqual(ids(all), ['m-owned', 'm-unowned', 'allocation:al-q1a', 'allocation:al-q2']);
  assert.equal(all.body.total, 4);
  assert.deepEqual(all.calls.allocation[0].where, { ccmId: 'ccm-a', status: 'assigned', creId: null });
  assert.equal(all.body.records[0].allocationQueue, false);
  assert.equal(all.body.records[1].allocationQueue, true);
  assert.equal(all.body.records[2].allocationOnly, true);
  assert.equal(all.body.records[2].mobile, null);

  const boundary = await run({ limit: '2', offset: '1' });
  assert.deepEqual(ids(boundary), ['m-unowned', 'allocation:al-q1a']);
  assert.equal(boundary.body.hasMore, true);

  assert.deepEqual(ids(await run({ creId: 'unassigned' })), ['m-unowned', 'allocation:al-q1a', 'allocation:al-q2']);
  assert.deepEqual(ids(await run({ creId: 'cre-1' })), ['m-owned']);
  assert.deepEqual(ids(await run({ dueCategory: 'allDue' })), []);
  assert.deepEqual(ids(await run({ dueCategory: 'pastDue' })), []);
  // Queue entries carry the raw allocation serviceType; master rows are classified. The master row for VIN-U
  // suppresses its own queue entry even though that master row does not match the filter.
  assert.deepEqual(ids(await run({ repairType: 'Paid' })), ['allocation:al-q1a']);
  assert.deepEqual(ids(await run({ repairType: 'Free' })), ['allocation:al-q2']);
  assert.deepEqual(ids(await run({ repairType: 'Others' })), ['m-owned', 'm-unowned']);
  // Queue entries match only on VIN and registration; they have no name, mobile or visit history.
  assert.deepEqual(ids(await run({ search: 'KA02Q2' })), ['allocation:al-q2']);
  assert.deepEqual(ids(await run({ search: 'vin-q1' })), ['allocation:al-q1a']);
  assert.deepEqual(ids(await run({ search: 'una' })), ['m-unowned']);
  assert.deepEqual(ids(await run({ search: 'alice' })), ['m-owned']);
});

test('allocation queue is a CCM-only construct: Admin, GM and CRE never query or receive queue entries', async () => {
  const rows = [makeRow('m-1', 'VIN-1', { ownerUserId: 'cre-1' })];
  const allocations = [makeAllocation('al-q', 'VIN-Q')];
  const users = [
    { role: 'ADMIN' },
    { role: 'GM', id: 'gm-1' },
    { role: 'CRE', id: 'cre-1', ccmId: 'ccm-a' },
  ];
  for (const user of users) {
    const response = await requestCallList({ user, rows, allocations, teams: [{ ccmId: 'ccm-a' }] });
    assert.equal(response.status, 200, user.role);
    assert.deepEqual(ids(response), ['m-1'], user.role);
    assert.equal(response.calls.allocation.length, 0, user.role);
  }
});

test('role visibility: scope comes from the role, GM teams are enforced, Free-Service CRE is refused', async () => {
  const ccm = await requestCallList({ user: { role: 'CCM', ccmId: 'ccm-a' } });
  assert.equal(ccm.calls.master[0].where.ccmId, 'ccm-a');

  // Distinct id: the response cache is keyed by user id, role, CCM and query.
  const cre = { role: 'CRE', id: 'cre-visibility', ccmId: 'ccm-a' };
  const creResponse = await requestCallList({ user: cre });
  assert.deepEqual(creResponse.calls.master[0].where, getVisibilityWhere(cre));

  const teams = [{ ccmId: 'ccm-a' }, { ccmId: 'ccm-c' }];
  const gmAll = await requestCallList({ user: { role: 'GM', id: 'gm-visibility' }, teams });
  assert.deepEqual(gmAll.calls.master[0].where, { ccmId: { in: ['ccm-a', 'ccm-c'] } });
  const gmOne = await requestCallList({ user: { role: 'GM', id: 'gm-visibility' }, teams, query: { ccmId: 'ccm-c' } });
  assert.deepEqual(gmOne.calls.master[0].where, { ccmId: 'ccm-c' });
  const gmForbidden = await requestCallList({ user: { role: 'GM', id: 'gm-visibility' }, teams, query: { ccmId: 'ccm-z' } });
  assert.equal(gmForbidden.status, 403);
  assert.equal(gmForbidden.calls.master.length, 0);

  const adminOne = await requestCallList({ user: { role: 'ADMIN' }, query: { ccmId: 'ccm-b' } });
  assert.deepEqual(adminOne.calls.master[0].where, { ccmId: 'ccm-b' });

  const freeService = await requestCallList({ user: { role: 'FREE_SERVICE_CRE', ccmId: 'ccm-a' } });
  assert.equal(freeService.status, 403);
  assert.equal(freeService.calls.master.length, 0);
});

test('page records are enriched from visit history: due category, due date, repair type, imported mobile, imported RO search', async () => {
  const now = new Date();
  const visit = (id, monthsBack, details = {}) => ({
    id,
    repairOrderNo: `RO-${id}`,
    ccmId: null,
    visitDate: new Date(now.getFullYear(), now.getMonth() - monthsBack, 15, 12, 0, 0),
    closingDate: null,
    gpDate: null,
    importedDetails: details,
  });
  const rows = [
    makeRow('m-1y', 'VIN-1Y', {
      createdAt: new Date('2026-01-03T00:00:00Z'),
      vehicle: makeVehicle('v-1y', [visit('1y', 12, { workType: 'Free Service', mobileNumber: '9876543210', roNumber: 'IMPORTED-RO-9' })]),
    }),
    makeRow('m-6m', 'VIN-6M', {
      createdAt: new Date('2026-01-02T00:00:00Z'),
      vehicle: makeVehicle('v-6m', [visit('6m', 6, { workType: 'Paid Service' })]),
    }),
    makeRow('m-future', 'VIN-FUT', {
      createdAt: new Date('2026-01-01T00:00:00Z'),
      vehicle: makeVehicle('v-fut', [visit('fut', -2, { workType: 'Paid Service' })]),
    }),
  ];
  const run = (query) => requestCallList({ user: { role: 'ADMIN' }, rows, query });

  const all = await run({});
  const byId = Object.fromEntries(all.body.records.map((record) => [record.id, record]));
  assert.equal(byId['m-1y'].dueCategory, '1y');
  assert.equal(byId['m-1y'].type, 'Free');
  assert.equal(byId['m-1y'].mobile, '9876543210');
  const visitDate = new Date(now.getFullYear(), now.getMonth() - 12, 15, 12, 0, 0);
  assert.equal(new Date(byId['m-1y'].dueDate).getTime(), new Date(visitDate.getFullYear() + 1, visitDate.getMonth(), 15).getTime());
  assert.equal(byId['m-6m'].dueCategory, '6m');
  assert.equal(byId['m-future'].dueCategory, null);
  // Page records are compact: visit history is used for filtering but not returned.
  assert.ok(all.body.records.every((record) => record.workshopVisits.length === 0 && record.importedDetails === null));

  assert.deepEqual(ids(await run({ dueCategory: '1y' })), ['m-1y']);
  assert.deepEqual(ids(await run({ dueCategory: '6m' })), ['m-6m']);
  assert.deepEqual(ids(await run({ dueCategory: 'allDue' })), ['m-1y', 'm-6m']);
  assert.deepEqual(ids(await run({ repairType: 'Free' })), ['m-1y']);
  assert.deepEqual(ids(await run({ search: 'imported-ro-9' })), ['m-1y']);
  assert.deepEqual(ids(await run({ search: '9876543210' })), ['m-1y']);
});
