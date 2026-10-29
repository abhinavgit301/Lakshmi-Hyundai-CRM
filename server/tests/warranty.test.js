import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyWarrantyCase,
  findMissedCases,
  isWarrantyCallable,
  warrantyCallingWindow,
  warrantyExpiryDate,
  warrantyLapseInstant,
} from '../src/utils/serviceCalendar.js';
import { workshopMonthOf, workshopMonthRange } from '../src/utils/workshopTime.js';

const d = (year, month, day) => new Date(year, month - 1, day);
const TZ = 'Asia/Kolkata';

test('warranty expires three calendar years after the sale date', () => {
  assert.equal(warrantyExpiryDate(d(2023, 12, 1)).getTime(), d(2026, 12, 1).getTime());
  assert.equal(warrantyExpiryDate(d(2023, 12, 31)).getTime(), d(2026, 12, 31).getTime());
  assert.equal(warrantyExpiryDate(d(2024, 2, 29)).getTime(), d(2027, 2, 28).getTime(), 'leap day clamps');
});

test('the calling window is the whole calendar month before the expiry month', () => {
  const cases = [
    [d(2026, 12, 1), d(2026, 11, 1), d(2026, 11, 30)],
    [d(2026, 12, 31), d(2026, 11, 1), d(2026, 11, 30)],
    [d(2027, 1, 15), d(2026, 12, 1), d(2026, 12, 31)],
    [d(2027, 2, 28), d(2027, 1, 1), d(2027, 1, 31)],
    [d(2027, 3, 1), d(2027, 2, 1), d(2027, 2, 28)],
  ];
  for (const [expiry, start, end] of cases) {
    const window = warrantyCallingWindow(expiry);
    assert.equal(window.start.getTime(), start.getTime());
    assert.equal(window.end.getTime(), end.getTime());
  }
});

test('every December expiry is visible from 1 to 30 November', () => {
  for (const expiryDay of [1, 10, 15, 31]) {
    const expiry = d(2026, 12, expiryDay);
    for (let day = 1; day <= 30; day += 1) assert.equal(isWarrantyCallable(expiry, d(2026, 11, day)), true, `expiry ${expiryDay} Dec, call day ${day} Nov`);
    assert.equal(isWarrantyCallable(expiry, d(2026, 10, 31)), false, 'not before November');
    assert.equal(isWarrantyCallable(expiry, d(2026, 12, 1)), false, 'removed when the expiry month begins');
  }
});

test('a 31 December expiry is eligible from 1 November, not 30 November', () => {
  assert.equal(isWarrantyCallable(d(2026, 12, 31), d(2026, 11, 1)), true);
});

test('January expiries are visible throughout December and gone in January', () => {
  const expiry = d(2027, 1, 15);
  assert.equal(isWarrantyCallable(expiry, d(2026, 11, 30)), false);
  for (let day = 1; day <= 31; day += 1) assert.equal(isWarrantyCallable(expiry, d(2026, 12, day)), true);
  assert.equal(isWarrantyCallable(expiry, d(2027, 1, 1)), false);
});

test('the window is a calendar month, not a rolling 30 days or an individual anniversary', () => {
  const expiry = d(2026, 12, 15);
  assert.equal(isWarrantyCallable(expiry, d(2026, 11, 1)), true, 'would be hidden by a rolling 30-day window');
  assert.equal(isWarrantyCallable(expiry, d(2026, 11, 14)), true, 'would be hidden by a one-month anniversary window');
  assert.equal(isWarrantyCallable(expiry, d(2026, 12, 2)), false, 'would still show in a rolling window');
});

test('the warranty lapses at the start of the day after expiry in the workshop timezone', () => {
  assert.equal(warrantyLapseInstant(d(2026, 12, 10), TZ).toISOString(), '2026-12-10T18:30:00.000Z');
});

const expiry = d(2026, 12, 10);
const answered = (createdAt, extra = {}) => ({ callSource: 'WARRANTY', outcome: 'CONTACTED', createdAt, ...extra });

test('a never-called warranty that has expired is missed', () => {
  const status = classifyWarrantyCase({ expiryDate: expiry, calls: [], now: new Date('2026-12-11T05:00:00Z'), timeZone: TZ });
  assert.deepEqual(status, { expired: true, contacted: false, missed: true });
});

test('calls that were never answered still leave the case missed', () => {
  const calls = ['NO_RESPONSE', 'WRONG_NUMBER', 'NO_RESPONSE'].map((outcome, index) => ({ callSource: 'WARRANTY', outcome, createdAt: new Date(Date.UTC(2026, 10, 10 + index)) }));
  assert.equal(classifyWarrantyCase({ expiryDate: expiry, calls, now: new Date('2026-12-12T00:00:00Z'), timeZone: TZ }).missed, true);
});

test('successful contact before expiry prevents a missed classification', () => {
  const calls = [answered(new Date('2026-11-20T06:00:00Z'))];
  assert.equal(classifyWarrantyCase({ expiryDate: expiry, calls, now: new Date('2026-12-12T00:00:00Z'), timeZone: TZ }).missed, false);
});

test('only answered warranty calls made before the lapse count as contact', () => {
  const now = new Date('2026-12-20T00:00:00Z');
  const afterLapse = [answered(new Date('2026-12-10T19:00:00Z'))];
  const otherSource = [answered(new Date('2026-11-20T06:00:00Z'), { callSource: 'SERVICE' })];
  assert.equal(classifyWarrantyCase({ expiryDate: expiry, calls: afterLapse, now, timeZone: TZ }).missed, true, 'contact after the lapse');
  assert.equal(classifyWarrantyCase({ expiryDate: expiry, calls: otherSource, now, timeZone: TZ }).missed, true, 'a service call is not warranty contact');
  const onExpiryDay = [answered(new Date('2026-12-10T10:00:00Z'))];
  assert.equal(classifyWarrantyCase({ expiryDate: expiry, calls: onExpiryDay, now, timeZone: TZ }).missed, false, 'still valid on the expiry day');
});

test('warranties that have not expired are never missed', () => {
  const status = classifyWarrantyCase({ expiryDate: expiry, calls: [], now: new Date('2026-12-10T12:00:00Z'), timeZone: TZ });
  assert.equal(status.expired, false);
  assert.equal(status.missed, false);
});

test('a case counts once however many attempts or duplicate rows exist', () => {
  const failedCalls = Array.from({ length: 5 }, (_, index) => ({ callSource: 'WARRANTY', outcome: 'NO_RESPONSE', createdAt: new Date(Date.UTC(2026, 10, 1 + index)) }));
  const entries = [
    { vehicleId: 'v1', expiryDate: expiry, calls: failedCalls },
    { vehicleId: 'v1', expiryDate: expiry, calls: failedCalls },
    { vehicleId: 'v2', expiryDate: expiry, calls: [answered(new Date('2026-11-05T06:00:00Z'))] },
    { vehicleId: 'v3', expiryDate: expiry, calls: [] },
  ];
  const missed = findMissedCases(entries, { now: new Date('2026-12-15T00:00:00Z'), timeZone: TZ });
  assert.deepEqual(missed.map((entry) => entry.vehicleId).sort(), ['v1', 'v3']);
});

test('each vehicle of one customer is evaluated separately', () => {
  const entries = [
    { vehicleId: 'car-1', expiryDate: expiry, calls: [answered(new Date('2026-11-02T06:00:00Z'))] },
    { vehicleId: 'car-2', expiryDate: expiry, calls: [] },
  ];
  const missed = findMissedCases(entries, { now: new Date('2026-12-15T00:00:00Z'), timeZone: TZ });
  assert.deepEqual(missed.map((entry) => entry.vehicleId), ['car-2']);
});

test('a missed case is not re-counted in later months', () => {
  // The monthly KPI attributes a case to the month its warranty expired in, so a December expiry
  // is outside January's expiry range and never carried forward.
  const inMonth = (expiryDate, year, month) => expiryDate >= new Date(year, month - 1, 1) && expiryDate < new Date(year, month, 1);
  assert.equal(inMonth(expiry, 2026, 12), true);
  assert.equal(inMonth(expiry, 2027, 1), false);
  assert.equal(inMonth(expiry, 2026, 11), false);
});

test('reporting months follow the workshop timezone, not UTC', () => {
  assert.deepEqual(workshopMonthOf(new Date('2026-10-31T19:00:00Z'), TZ), { year: 2026, month: 11 }, '00:30 IST on 1 November');
  assert.deepEqual(workshopMonthOf(new Date('2026-10-31T17:00:00Z'), TZ), { year: 2026, month: 10 });
  const range = workshopMonthRange(2026, 11, TZ);
  assert.equal(range.start.toISOString(), '2026-10-31T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-11-30T18:30:00.000Z');
  const december = workshopMonthRange(2026, 12, TZ);
  assert.equal(december.end.toISOString(), '2026-12-31T18:30:00.000Z');
  assert.equal(workshopMonthRange(2026, 13, TZ).start.toISOString(), workshopMonthRange(2027, 1, TZ).start.toISOString());
});
