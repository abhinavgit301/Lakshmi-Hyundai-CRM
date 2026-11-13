import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { classifyDueCohorts, loadCallListRecords, loadDueCohorts } from '../src/controllers/recordsController.js';
import {
  compareByDueDateThenId,
  decodeDueCursor,
  encodeDueCursor,
  paginateByCursor,
} from '../src/utils/pagination.js';
import { classifyServiceDue, dueCohortServiceDateRanges } from '../src/utils/serviceDue.js';

test('cohort date ranges contain every lastServiceDate classifyServiceDue accepts', () => {
  let accepted = 0;
  for (let nowOffset = 0; nowOffset < 900; nowOffset += 3) {
    const now = new Date(2026, 0, 1 + nowOffset, 13, 30);
    const { oneYear, sixMonth } = dueCohortServiceDateRanges(now);
    for (let daysAgo = -5; daysAgo < 520; daysAgo += 1) {
      for (const hour of [0, 23]) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, 59, 59);
        const cohort = classifyServiceDue(date, now);
        if (!cohort) continue;
        accepted += 1;
        const { gte, lt } = cohort === '1y' ? oneYear : sixMonth;
        assert.ok(date >= gte && date < lt, `${cohort} ${date.toISOString()} outside range for ${now.toISOString()}`);
      }
    }
  }
  assert.ok(accepted > 0);
});

test('due cohorts use the latest completed free service until paid servicing starts', () => {
  const now = new Date(2026, 10, 4, 10);
  const saleDate = new Date(2023, 10, 10);
  const freeVisits = [
    { visitDate: new Date(2024, 0, 12), importedDetails: { workType: 'Free Service' } },
    { visitDate: new Date(2024, 10, 12), importedDetails: { workType: 'FOC Service' } },
    { visitDate: new Date(2025, 10, 12), importedDetails: { workType: 'Free Service' } },
  ];
  const { oneYear, sixMonth } = classifyDueCohorts([
    {
      id: 'in-free-phase',
      saleDate: new Date(2026, 2, 10),
      workshopVisits: [{ visitDate: new Date(2026, 4, 10), importedDetails: { workType: 'Free Service' } }],
    },
    { id: 'post-free', saleDate, workshopVisits: freeVisits },
    {
      id: 'paid-priority',
      saleDate,
      workshopVisits: [
        ...freeVisits,
        { visitDate: new Date(2026, 4, 10), importedDetails: { workType: 'Paid Service' } },
        { visitDate: new Date(2026, 9, 10), importedDetails: { workType: 'Free Service' } },
      ],
    },
  ], now);

  assert.deepEqual(oneYear.map(({ id }) => id), ['post-free']);
  assert.equal(oneYear[0].lastServiceDate.getTime(), new Date(2025, 10, 12).getTime());
  assert.deepEqual(sixMonth.map(({ id }) => id), ['paid-priority']);
  assert.equal(sixMonth[0].lastServiceDate.getTime(), new Date(2026, 4, 10).getTime());
});

test('candidate loading matches full-scan cohorts and preserves canonical rows and tenant scope', async () => {
  const now = new Date(2026, 10, 4, 10);
  const visit = (date, type, ccmId = 'ccm-a') => ({
    id: `${date}-${type}`, visitDate: new Date(date), ccmId,
    importedDetails: { workType: type },
  });
  const makeRow = (id, vin, visits, overrides = {}) => ({
    id, vin, ccmId: 'ccm-a', ownerUserId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    customerName: id, mobileNumber: '', status: 'pending', registrationNumber: null,
    vehicle: {
      id: `vehicle-${id}`, customerId: `customer-${id}`, model: null, saleDate: null,
      registrationNumber: null, physicalVehicleId: `physical-${vin}`,
      physicalVehicle: { workshopVisits: visits },
      allocations: [], monthlyDataEntries: [], appointments: [], customer: { appointments: [] },
    },
    ...overrides,
  });
  const rows = [
    makeRow('paid', 'paid', [
      visit('2025-11-12', 'Paid Service', 'ccm-b'),
      visit('2026-10-12', 'Free Service'),
      visit('2027-01-01', 'Paid Service'),
    ]),
    makeRow('six', 'six', [visit('2026-05-10', 'Paid Service')]),
    makeRow('post-free', 'post-free', [
      visit('2024-01-12', 'Free Service'),
      visit('2024-11-12', 'FOC Service'),
      visit('2025-11-12', 'Free Service'),
    ], { vehicle: {
      id: 'vehicle-post-free', customerId: 'customer-post-free', model: null,
      saleDate: new Date(2023, 10, 10), registrationNumber: null,
      physicalVehicleId: 'physical-post-free',
      physicalVehicle: { workshopVisits: [
        visit('2024-01-12', 'Free Service'),
        visit('2024-11-12', 'FOC Service'),
        visit('2025-11-12', 'Free Service'),
      ] },
      allocations: [], monthlyDataEntries: [], appointments: [], customer: { appointments: [] },
    } }),
    makeRow('outside', 'outside', [visit('2023-02-01', 'Paid Service')]),
    makeRow('duplicate-candidate', 'duplicate', [visit('2025-11-10', 'Paid Service')]),
    makeRow('duplicate-canonical', 'duplicate', [], { ownerUserId: 'owner', vehicle: null }),
    makeRow('other-team', 'other-team', [visit('2025-11-10', 'Paid Service')], { ccmId: 'ccm-b' }),
  ];
  const originalMaster = prisma.masterCallList.findMany;
  const originalUser = prisma.user.findMany;
  const calls = [];
  prisma.user.findMany = async () => [];
  prisma.masterCallList.findMany = async (args) => {
    calls.push(args);
    const conditions = args.where.AND || [args.where];
    let matching = rows.filter((row) => row.ccmId === 'ccm-a');
    const candidate = conditions.find((condition) => condition.vehicle?.is?.physicalVehicle);
    const vinCondition = conditions.find((condition) => condition.vin?.in);
    const idCondition = conditions.find((condition) => condition.id?.gt);
    const cursorCondition = conditions.find((condition) => condition.OR?.[0]?.createdAt);
    if (candidate) {
      const ranges = candidate.vehicle.is.physicalVehicle.is.workshopVisits.some.OR.map(({ visitDate }) => visitDate);
      matching = matching.filter((row) => row.vehicle?.physicalVehicle.workshopVisits.some(
        ({ visitDate }) => ranges.some(({ gte, lt }) => visitDate >= gte && visitDate < lt),
      ));
    }
    if (vinCondition) matching = matching.filter((row) => vinCondition.vin.in.includes(row.vin));
    if (idCondition) matching = matching.filter((row) => row.id > idCondition.id.gt);
    if (cursorCondition) {
      const { createdAt, id } = cursorCondition.OR[1];
      matching = matching.filter((row) => row.createdAt < createdAt
        || (row.createdAt.getTime() === createdAt.getTime() && row.id < id.lt));
    }
    matching.sort(args.orderBy.id === 'asc'
      ? (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      : (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return matching.slice(0, args.take);
  };
  try {
    const where = { ccmId: 'ccm-a' };
    const user = { role: 'CCM', ccmId: 'ccm-a' };
    const full = classifyDueCohorts(await loadCallListRecords(where, now, user), now);
    calls.length = 0;
    const narrowed = await loadDueCohorts(where, now, user);
    assert.deepEqual(narrowed, full);
    assert.deepEqual(narrowed.oneYear.map(({ id }) => id), ['paid', 'post-free']);
    assert.deepEqual(narrowed.sixMonth.map(({ id }) => id), ['six']);
    assert.deepEqual(calls[0].select, { id: true, vin: true });
    assert.ok(calls[1].where.AND[1].vin.in.includes('duplicate'));
    assert.ok(!calls[1].where.AND[1].vin.in.includes('outside'));
    assert.ok(!calls[1].where.AND[1].vin.in.includes('other-team'));
  } finally {
    prisma.masterCallList.findMany = originalMaster;
    prisma.user.findMany = originalUser;
  }
});

test('candidate IDs and VINs are batched without losing candidates at the boundary', async () => {
  const originalMaster = prisma.masterCallList.findMany;
  const candidateRows = Array.from({ length: 501 }, (_, index) => ({
    id: `row-${String(index).padStart(3, '0')}`,
    vin: `vin-${String(index).padStart(3, '0')}`,
  }));
  const candidateCalls = [];
  const detailChunks = [];
  prisma.masterCallList.findMany = async (args) => {
    if (args.select.vin === true && args.select.id === true && !args.select.vehicle) {
      candidateCalls.push(args);
      const after = args.where.AND.find((condition) => condition.id?.gt)?.id.gt;
      return candidateRows.filter((row) => !after || row.id > after).slice(0, args.take);
    }
    detailChunks.push(args.where.AND[1].vin.in);
    return [];
  };
  try {
    assert.deepEqual(await loadDueCohorts({ ccmId: 'ccm-a' }, new Date(2026, 10, 4), {
      role: 'CCM', ccmId: 'ccm-a',
    }), { oneYear: [], sixMonth: [] });
    assert.equal(candidateCalls.length, 2);
    assert.equal(candidateCalls[1].where.AND[2].id.gt, 'row-499');
    assert.deepEqual(detailChunks.map((chunk) => chunk.length), [500, 1]);
    assert.equal(detailChunks[1][0], 'vin-500');
  } finally {
    prisma.masterCallList.findMany = originalMaster;
  }
});

function dueRecords(count, distinctDueDates) {
  return Array.from({ length: count }, (_, index) => ({
    id: `rec-${String(index * 7919 % 10007).padStart(5, '0')}`,
    dueDate: new Date(2026, 11, 1 + (index % distinctDueDates)),
  })).sort(compareByDueDateThenId);
}

test('keyset pagination returns every record once, in order, even with many identical due dates', () => {
  const records = dueRecords(237, 9);
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = paginateByCursor(records, { limit: 50, cursor: cursor || { dueDate: new Date(0), id: '' } });
    seen.push(...page.records.map((record) => record.id));
    pages += 1;
    assert.equal(page.total, records.length);
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
      break;
    }
    cursor = decodeDueCursor(page.nextCursor);
    assert.ok(cursor);
  }
  assert.equal(pages, 5);
  assert.deepEqual(seen, records.map((record) => record.id));
  assert.equal(new Set(seen).size, records.length);
});

test('keyset pages stay consistent when rows disappear or appear between requests', () => {
  const records = dueRecords(120, 6);
  const first = paginateByCursor(records, { limit: 50, cursor: { dueDate: new Date(0), id: '' } });
  const lastOfFirst = first.records.at(-1);
  // Remove the cursor row and earlier rows, and add a new row that sorts before the cursor.
  const changed = records.filter((record, index) => index > 10 && record.id !== lastOfFirst.id);
  changed.push({ id: 'rec-00000-new', dueDate: new Date(2026, 11, 1) });
  changed.sort(compareByDueDateThenId);
  const second = paginateByCursor(changed, { limit: 50, cursor: decodeDueCursor(first.nextCursor) });
  assert.ok(second.records.every((record) => compareByDueDateThenId(record, lastOfFirst) > 0));
  const expected = changed.filter((record) => compareByDueDateThenId(record, lastOfFirst) > 0).slice(0, 50);
  assert.deepEqual(second.records.map((record) => record.id), expected.map((record) => record.id));
});

test('cursors round-trip and invalid cursors are rejected', () => {
  const record = { id: 'rec-1', dueDate: new Date(2026, 5, 15) };
  const decoded = decodeDueCursor(encodeDueCursor(record));
  assert.equal(decoded.id, 'rec-1');
  assert.equal(decoded.dueDate.getTime(), record.dueDate.getTime());
  for (const bad of ['', 'not-base64!!', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('["nope","x"]').toString('base64url'), Buffer.from('["2026-01-01T00:00:00.000Z",5]').toString('base64url')]) {
    assert.equal(decodeDueCursor(bad), null, bad);
  }
});
