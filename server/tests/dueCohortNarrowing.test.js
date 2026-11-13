import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDueCohorts } from '../src/controllers/recordsController.js';
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
