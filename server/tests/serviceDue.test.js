import test from 'node:test';
import assert from 'node:assert/strict';

import { addMonths, classifyServiceDue, getLatestServiceDate } from '../src/utils/serviceDue.js';

const now = new Date(2026, 9, 25); // October 2026

test('latest qualifying service ignores undated and future repair orders', () => {
  const latest = getLatestServiceDate([
    { visitDate: new Date(2026, 3, 10) },
    { visitDate: null },
    { visitDate: new Date(2026, 11, 1) },
    { visitDate: new Date(2026, 1, 2) },
  ], now);
  assert.equal(latest.getTime(), new Date(2026, 3, 10).getTime());
  assert.equal(getLatestServiceDate([{ visitDate: null }], now), null);
});

test('addMonths clamps to the end of shorter months', () => {
  assert.equal(addMonths(new Date(2026, 7, 31), 6).getTime(), new Date(2027, 1, 28).getTime());
});

// Month-wise cohort: this month's 1-Year Due list is exactly "same month, last year".
test('one-year due is an exact same-month-last-year cohort', () => {
  assert.equal(classifyServiceDue(new Date(2025, 9, 1), now), '1y');
  assert.equal(classifyServiceDue(new Date(2025, 9, 28), now), '1y');
  assert.equal(classifyServiceDue(new Date(2025, 8, 30), now), null, 'one month off does not match');
  assert.equal(classifyServiceDue(new Date(2025, 10, 1), now), null, 'one month off the other way does not match');
  assert.equal(classifyServiceDue(new Date(2024, 9, 15), now), null, 'two years ago does not match');
});

// Month-wise cohort: this month's 6-Month Due list is exactly "6 calendar months ago".
test('six-month due is an exact six-calendar-months-ago cohort', () => {
  assert.equal(classifyServiceDue(new Date(2026, 3, 1), now), '6m');
  assert.equal(classifyServiceDue(new Date(2026, 3, 30), now), '6m');
  assert.equal(classifyServiceDue(new Date(2026, 2, 28), now), null);
  assert.equal(classifyServiceDue(new Date(2026, 4, 2), now), null);
  assert.equal(classifyServiceDue(null, now), null);
});

test('one-year and six-month cohorts never overlap', () => {
  for (let monthsAgo = 0; monthsAgo <= 24; monthsAgo += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 10);
    const result = classifyServiceDue(date, now);
    assert.ok(result === null || result === '1y' || result === '6m');
    if (monthsAgo !== 12) assert.notEqual(result, '1y');
    if (monthsAgo !== 6) assert.notEqual(result, '6m');
  }
});
