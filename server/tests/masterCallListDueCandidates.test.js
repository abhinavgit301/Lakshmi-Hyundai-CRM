import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import {
  isMasterCallListDueCandidateEnabled,
  getCallList,
  loadCallListRecords,
  loadMasterDueCandidatePage,
  masterDueCandidateWhere,
} from '../src/controllers/recordsController.js';
import { classifyServiceDue, getYearlyDueDate } from '../src/utils/serviceDue.js';

test('due candidate flag is separately opt-in', () => {
  for (const value of [undefined, '', 'false', '0', 'yes']) {
    assert.equal(isMasterCallListDueCandidateEnabled({ MASTER_CALL_LIST_DUE_CANDIDATES_ENABLED: value }), false);
  }
  for (const value of ['true', ' TRUE ', '1']) {
    assert.equal(isMasterCallListDueCandidateEnabled({ MASTER_CALL_LIST_DUE_CANDIDATES_ENABLED: value }), true);
  }
});

test('controller uses candidate selection only when the separate flag is enabled', async () => {
  const originalMaster = prisma.masterCallList.findMany;
  const originalFlag = process.env.MASTER_CALL_LIST_DUE_CANDIDATES_ENABLED;
  const originalSqlFlag = process.env.MASTER_CALL_LIST_SQL_ENABLED;
  const calls = [];
  prisma.masterCallList.findMany = async (args) => { calls.push(args); return []; };
  process.env.MASTER_CALL_LIST_SQL_ENABLED = 'true';
  try {
    for (const flag of ['false', 'true']) {
      process.env.MASTER_CALL_LIST_DUE_CANDIDATES_ENABLED = flag;
      calls.length = 0;
      const response = { json(body) { this.body = body; return this; } };
      await getCallList({
        user: { role: 'ADMIN', id: `due-flag-${flag}` },
        query: { dueCategory: 'pastDue', limit: '50', offset: '0' },
      }, response);
      assert.equal(response.body.total, 0);
      assert.equal(Boolean(calls[0].select.vehicle), flag === 'false');
    }
  } finally {
    prisma.masterCallList.findMany = originalMaster;
    if (originalFlag === undefined) delete process.env.MASTER_CALL_LIST_DUE_CANDIDATES_ENABLED;
    else process.env.MASTER_CALL_LIST_DUE_CANDIDATES_ENABLED = originalFlag;
    if (originalSqlFlag === undefined) delete process.env.MASTER_CALL_LIST_SQL_ENABLED;
    else process.env.MASTER_CALL_LIST_SQL_ENABLED = originalSqlFlag;
  }
});

test('candidate ranges contain every possible due reference, including leap days and local day boundaries', () => {
  for (let day = 0; day < 1200; day += 7) {
    const now = new Date(2024, 0, 1 + day, 12);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const pastLimit = masterDueCandidateWhere('pastDue', now).vehicle.is.physicalVehicle.is.workshopVisits.some.visitDate.lt;
    const ranges = Object.fromEntries(['1y', '6m'].map((category) => [
      category,
      masterDueCandidateWhere(category, now).vehicle.is.physicalVehicle.is.workshopVisits.some.visitDate,
    ]));
    const allRanges = masterDueCandidateWhere('allDue', now).vehicle.is.physicalVehicle.is.workshopVisits.some.OR;
    for (let ago = 0; ago < 900; ago += 1) {
      for (const hour of [0, 23]) {
        const visitDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago, hour, 59);
        const category = classifyServiceDue(visitDate, now);
        if (category) {
          assert.ok(visitDate >= ranges[category].gte && visitDate < ranges[category].lt);
          assert.ok(allRanges.some(({ visitDate: range }) => visitDate >= range.gte && visitDate < range.lt));
        }
        const dueDate = getYearlyDueDate([{ visitDate }]);
        if (visitDate <= now && dueDate < today) assert.ok(visitDate < pastLimit);
      }
    }
  }
});

test('candidate pages match full-scan lifecycle results, scope, filters, canonicalization and pagination', async () => {
  const now = new Date();
  const dateMonthsAgo = (months) => new Date(now.getFullYear(), now.getMonth() - months, 10, 12);
  const visit = (months, workType) => ({
    id: `${months}-${workType}`, ccmId: 'team-a', visitDate: dateMonthsAgo(months),
    importedDetails: { workType, roNumber: 'RO-MATCH' },
  });
  const row = (id, vin, visits, extra = {}) => ({
    id, vin, ccmId: 'team-a', ownerUserId: 'cre-a',
    createdAt: new Date(2025, 0, 1 + Number(id.replace(/\D/g, '') || 0)),
    customerName: `Customer ${id}`, mobileNumber: '123', registrationNumber: 'REG',
    status: 'pending',
    vehicle: {
      id: `vehicle-${id}`, customerId: `customer-${id}`, model: 'Model', saleDate: null,
      registrationNumber: 'REG', physicalVehicleId: `physical-${id}`,
      physicalVehicle: { workshopVisits: visits },
      allocations: [], monthlyDataEntries: [],
      appointments: [{ id: 'appointment', scheduledAt: new Date(now.getTime() + 86400000), status: 'PENDING' }],
      customer: { appointments: [] },
    },
    ...extra,
  });
  const rows = [
    row('1', 'overdue', [visit(15, 'Paid Service'), visit(1, 'Free Service'), visit(-1, 'Paid Service')]),
    row('2', 'year', [visit(12, 'Paid Service')]),
    row('3', 'six', [visit(6, 'Paid Service')]),
    row('4', 'unknown', [visit(18, 'Unknown')]),
    row('5', 'undated', [{ ...visit(18, 'Paid Service'), visitDate: null }]),
    row('6', 'duplicate', [visit(15, 'Paid Service')], { ownerUserId: null }),
    row('7', 'duplicate', [], { vehicle: null }),
    row('8', 'other-team', [visit(15, 'Paid Service')], { ccmId: 'team-b' }),
    row('9', 'other-owner', [visit(15, 'Paid Service')], { ownerUserId: 'cre-b' }),
    row('10', 'free-phase', [visit(15, 'Free Service')]),
    row('11', 'post-free', [
      { ...visit(24, 'Free Service'), visitDate: new Date(now.getFullYear() - 2, 2, 10) },
      { ...visit(36, 'FOC Service'), visitDate: new Date(now.getFullYear() - 3, 2, 10) },
      { ...visit(46, 'Free Service'), visitDate: new Date(now.getFullYear() - 4, 4, 10) },
    ], { vehicle: {
      id: 'vehicle-11', customerId: 'customer-11', model: 'Model',
      saleDate: new Date(now.getFullYear() - 4, 2, 10), registrationNumber: 'REG',
      physicalVehicleId: 'physical-11',
      physicalVehicle: { workshopVisits: [
        { ...visit(24, 'Free Service'), visitDate: new Date(now.getFullYear() - 2, 2, 10) },
        { ...visit(36, 'FOC Service'), visitDate: new Date(now.getFullYear() - 3, 2, 10) },
        { ...visit(46, 'Free Service'), visitDate: new Date(now.getFullYear() - 4, 4, 10) },
      ] },
      allocations: [], monthlyDataEntries: [], appointments: [], customer: { appointments: [] },
    } }),
  ];
  const queue = [{
    id: 'allocation:q', vin: 'overdue', ccmId: 'team-a', assigneeId: null,
    dueCategory: null, dueDate: null, workshopVisits: [],
  }];
  const originalMaster = prisma.masterCallList.findMany;
  const originalUser = prisma.user.findMany;
  const calls = [];
  function matches(row, condition) {
    if (condition.AND) return condition.AND.every((entry) => matches(row, entry));
    if (condition.OR) return condition.OR.some((entry) => matches(row, entry));
    if (condition.ccmId && row.ccmId !== condition.ccmId) return false;
    if (condition.ownerUserId && row.ownerUserId !== condition.ownerUserId) return false;
    if (condition.id?.gt && !(row.id > condition.id.gt)) return false;
    if (condition.id?.in && !condition.id.in.includes(row.id)) return false;
    if (condition.vin?.in && !condition.vin.in.includes(row.vin)) return false;
    if (condition.createdAt?.lt && !(row.createdAt < condition.createdAt.lt)) return false;
    if (condition.createdAt instanceof Date && row.createdAt.getTime() !== condition.createdAt.getTime()) return false;
    if (condition.id?.lt && !(row.id < condition.id.lt)) return false;
    const some = condition.vehicle?.is?.physicalVehicle?.is?.workshopVisits?.some;
    if (some) {
      const ranges = some.OR ? some.OR.map((entry) => entry.visitDate) : [some.visitDate];
      return (row.vehicle?.physicalVehicle?.workshopVisits || []).some(({ visitDate }) => visitDate
        && ranges.some((range) => (!range.gte || visitDate >= range.gte) && (!range.lt || visitDate < range.lt)));
    }
    return true;
  }
  prisma.masterCallList.findMany = async (args) => {
    calls.push(args);
    const filtered = rows.filter((entry) => matches(entry, args.where));
    filtered.sort(Array.isArray(args.orderBy)
      ? (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
      : (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return filtered.slice(0, args.take).map((entry) => {
      if (!args.select.vehicle || args.select.vehicle.select.appointments || !entry.vehicle) return entry;
      const { appointments, customer, ...vehicle } = entry.vehicle;
      return { ...entry, vehicle };
    });

  };
  prisma.user.findMany = async () => [{ id: 'cre-a', name: 'Owner A' }, { id: 'cre-b', name: 'Owner B' }];
  try {
    for (const user of [{ role: 'CCM', ccmId: 'team-a' }, { role: 'CRE', ccmId: 'team-a', id: 'cre-a' }, { role: 'ADMIN' }]) {
      const where = user.role === 'ADMIN' ? {} : {
        ccmId: 'team-a', ...(user.role === 'CRE' ? { ownerUserId: 'cre-a' } : {}),
      };
      for (const dueCategory of ['1y', '6m', 'allDue', 'pastDue']) {
        for (const extra of [{}, { search: 'ro-match', repairType: 'Free' }, { creId: 'cre-a' }]) {
          const filters = { creId: '', dueCategory, repairType: '', search: '', ...extra };
          for (const pagination of [{ limit: 1, offset: 0 }, { limit: 1, offset: 1 }, { limit: 5, offset: 50 }]) {
            const full = await loadCallListRecords(where, now, user, { page: pagination, filters, allocationQueueRecords: queue });
            calls.length = 0;
            const narrowed = await loadMasterDueCandidatePage({ where, now, user, pagination, filters, allocationQueueRecords: queue });
            assert.deepEqual(narrowed, full, JSON.stringify({ user, filters, pagination }));
            assert.equal(calls[0].select.vehicle, undefined);
            for (const call of calls.filter((entry) => entry.select.vehicle && entry.where.AND?.[1]?.vin)) {
              assert.equal(call.select.vehicle.select.appointments, undefined);
            }
          }
        }
      }
    }
  } finally {
    prisma.masterCallList.findMany = originalMaster;
    prisma.user.findMany = originalUser;
  }
});

test('candidate VIN selection and subsequent record loads are batched at 500', async () => {
  const originalMaster = prisma.masterCallList.findMany;
  const candidateRows = Array.from({ length: 501 }, (_, index) => ({
    id: `row-${String(index).padStart(3, '0')}`,
    vin: `vin-${String(index).padStart(3, '0')}`,
  }));
  const selectedChunks = [];
  let candidateQueries = 0;
  prisma.masterCallList.findMany = async (args) => {
    if (!args.select.vehicle) {
      candidateQueries += 1;
      const after = args.where.AND.find((condition) => condition.id?.gt)?.id.gt;
      return candidateRows.filter((row) => !after || row.id > after).slice(0, args.take);
    }
    selectedChunks.push(args.where.AND[1].vin.in);
    return [];
  };
  try {
    const result = await loadMasterDueCandidatePage({
      where: { ccmId: 'team-a' }, now: new Date(), user: { role: 'CCM', ccmId: 'team-a' },
      pagination: { limit: 50, offset: 0 },
      filters: { dueCategory: 'pastDue', search: '', creId: '', repairType: '' },
    });
    assert.deepEqual(result.records, []);
    assert.equal(result.total, 0);
    assert.equal(candidateQueries, 2);
    assert.deepEqual(selectedChunks.map((chunk) => chunk.length), [500, 1]);
    assert.deepEqual(selectedChunks.flat(), candidateRows.map(({ vin }) => vin));
  } finally {
    prisma.masterCallList.findMany = originalMaster;
  }
});

test('a selected record disappearing before detail loading fails explicitly', async () => {
  const originalMaster = prisma.masterCallList.findMany;
  const visitDate = new Date();
  visitDate.setFullYear(visitDate.getFullYear() - 3);
  const row = {
    id: 'one', vin: 'vin-one', ccmId: 'team-a', ownerUserId: null,
    createdAt: new Date(), customerName: 'Customer', mobileNumber: '', status: 'pending',
    vehicle: {
      id: 'vehicle', customerId: 'customer', physicalVehicleId: 'physical',
      physicalVehicle: { workshopVisits: [{ id: 'visit', visitDate, importedDetails: { workType: 'Paid' } }] },
      allocations: [], monthlyDataEntries: [],
    },
  };
  prisma.masterCallList.findMany = async (args) => {
    if (!args.select.vehicle) return [{ id: row.id, vin: row.vin }];
    return args.where.AND[1].vin ? [row] : [];
  };
  try {
    await assert.rejects(
      loadMasterDueCandidatePage({
        where: { ccmId: 'team-a' }, now: new Date(), user: { role: 'CCM', ccmId: 'team-a' },
        pagination: { limit: 50, offset: 0 },
        filters: { dueCategory: 'pastDue', search: '', creId: '', repairType: '' },
      }),
      { code: 'MASTER_CALL_LIST_PAGE_INCOMPLETE' },
    );
  } finally {
    prisma.masterCallList.findMany = originalMaster;
  }
});
