import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDueCohorts } from '../src/controllers/recordsController.js';
import {
  compareByDueDateThenId,
  decodeDueCursor,
  encodeDueCursor,
  paginateByCursor,
} from '../src/utils/pagination.js';
import { classifyServiceDue, dueCohortServiceDateRanges, getLatestServiceDate } from '../src/utils/serviceDue.js';

// Mirrors dueCohortCandidateWhere: what the database narrowing lets through for a stored lastServiceDate.
function isCandidate(lastServiceDate, now) {
  if (!lastServiceDate) return false;
  const { oneYear, sixMonth } = dueCohortServiceDateRanges(now);
  const within = ({ gte, lt }) => lastServiceDate >= gte && lastServiceDate < lt;
  return within(oneYear) || within(sixMonth) || lastServiceDate > now;
}

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function buildVehicles(now, count, random) {
  const vehicles = [];
  for (let index = 0; index < count; index += 1) {
    const visitCount = Math.floor(random() * 4);
    const workshopVisits = Array.from({ length: visitCount }, () => {
      const roll = random();
      // Mix of past dates, boundary dates, future dates and missing dates.
      const daysAgo = roll < 0.1 ? -Math.floor(random() * 40) : Math.floor(random() * 460);
      const visitDate = roll > 0.93 ? null : new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, Math.floor(random() * 24));
      return { visitDate };
    });
    vehicles.push({ id: `rec-${String(index).padStart(4, '0')}`, workshopVisits });
  }
  return vehicles;
}

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

test('narrowed candidates classify exactly like the full scan, including future-dated and missing visits', () => {
  for (const now of [new Date(2026, 10, 4, 10), new Date(2026, 0, 31, 23, 59), new Date(2027, 2, 1, 0, 0), new Date(2026, 7, 31, 12)]) {
    const vehicles = buildVehicles(now, 1500, seededRandom(now.getTime() % 100_000));
    const withDueDate = (cohort) => cohort.map((record) => ({ id: record.id, dueDate: record.dueDate.getTime(), last: record.lastServiceDate.getTime() }));
    const full = classifyDueCohorts(vehicles, now);
    const narrowed = classifyDueCohorts(
      vehicles.filter((vehicle) => {
        const dates = vehicle.workshopVisits.map((visit) => visit.visitDate).filter(Boolean);
        const stored = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null;
        return isCandidate(stored, now);
      }),
      now,
    );
    assert.deepEqual(withDueDate(narrowed.oneYear), withDueDate(full.oneYear));
    assert.deepEqual(withDueDate(narrowed.sixMonth), withDueDate(full.sixMonth));
    assert.ok(full.oneYear.length > 0 && full.sixMonth.length > 0);
    assert.ok(vehicles.some((vehicle) => vehicle.workshopVisits.some((visit) => visit.visitDate > now)), 'test data includes future-dated visits');
  }
});

test('a vehicle whose newest visit is in the future is still a candidate and uses its latest past visit', () => {
  const now = new Date(2026, 10, 4, 10);
  const past = new Date(2025, 10, 10);
  const vehicle = { id: 'rec-1', workshopVisits: [{ visitDate: new Date(2026, 10, 20) }, { visitDate: past }] };
  assert.equal(getLatestServiceDate(vehicle.workshopVisits, now).getTime(), past.getTime());
  assert.equal(isCandidate(new Date(2026, 10, 20), now), true);
  assert.equal(classifyDueCohorts([vehicle], now).oneYear.length, 1);
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
