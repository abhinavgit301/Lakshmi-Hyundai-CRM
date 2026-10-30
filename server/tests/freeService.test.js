import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countRemainingFreeServiceMilestones,
  findCompletingVisit,
  freeServiceCallStart,
  freeServiceCustomerIdsForMonth,
  freeServiceDueDate,
  isFreeServiceCallable,
  normalizeSaleDate,
  resolveSaleDate,
} from '../src/utils/serviceCalendar.js';

const d = (year, month, day) => new Date(year, month - 1, day);

test('free-service milestones are sale + 2 months, 1 year and 2 years', () => {
  const sale = d(2024, 3, 10);
  assert.equal(freeServiceDueDate(sale, 1).getTime(), d(2024, 5, 10).getTime());
  assert.equal(freeServiceDueDate(sale, 2).getTime(), d(2025, 3, 10).getTime());
  assert.equal(freeServiceDueDate(sale, 3).getTime(), d(2026, 3, 10).getTime());
  assert.equal(freeServiceDueDate(sale, 4), null);
});

test('free-service dates clamp at month ends and across leap years', () => {
  assert.equal(freeServiceDueDate(d(2024, 12, 31), 1).getTime(), d(2025, 2, 28).getTime());
  assert.equal(freeServiceDueDate(d(2023, 12, 31), 1).getTime(), d(2024, 2, 29).getTime());
  assert.equal(freeServiceDueDate(d(2024, 2, 29), 2).getTime(), d(2025, 2, 28).getTime());
  assert.equal(freeServiceDueDate(d(2024, 2, 29), 3).getTime(), d(2026, 2, 28).getTime());
  assert.equal(freeServiceDueDate(d(2022, 2, 28), 3).getTime(), d(2024, 2, 28).getTime());
});

test('calling eligibility begins 14 calendar days before the due date', () => {
  assert.equal(freeServiceCallStart(d(2026, 12, 15)).getTime(), d(2026, 12, 1).getTime());
  assert.equal(freeServiceCallStart(d(2026, 3, 5)).getTime(), d(2026, 2, 19).getTime());
  assert.equal(freeServiceCallStart(d(2025, 1, 10)).getTime(), d(2024, 12, 27).getTime());
});

test('customers are excluded before the calling eligibility date', () => {
  const due = d(2026, 12, 15);
  assert.equal(isFreeServiceCallable(due, d(2026, 11, 30)), false, 'inside the one-month window but before Dec 1');
  assert.equal(isFreeServiceCallable(due, d(2026, 11, 20)), false);
  assert.equal(isFreeServiceCallable(due, d(2026, 12, 1)), true, 'calling opens on the eligibility date');
  assert.equal(isFreeServiceCallable(due, d(2026, 12, 14)), true);
  assert.equal(isFreeServiceCallable(due, d(2026, 12, 15)), true, 'the due date itself is inclusive');
  assert.equal(isFreeServiceCallable(due, d(2026, 12, 16)), false, 'past due is no longer in the window');
});

test('the due date must fall within the next rolling calendar month, inclusive', () => {
  // Calling window opens 14 days earlier, so the one-month ceiling is only reached by the due date itself.
  assert.equal(isFreeServiceCallable(d(2027, 1, 31), d(2026, 12, 31)), false);
  // Calendar-month arithmetic, not 30 days: 31 Jan + 1 month clamps to 28 Feb.
  assert.equal(isFreeServiceCallable(d(2026, 2, 28), d(2026, 1, 31)), false, 'before 14-day calling start');
  assert.equal(isFreeServiceCallable(d(2026, 2, 10), d(2026, 1, 31)), true);
});

test('a free-service repair order near the due date completes the milestone', () => {
  const due = d(2026, 5, 10);
  const visits = [
    { repairOrderNo: 'RO-PAID', visitDate: d(2026, 5, 9), importedDetails: { workType: 'Paid Service' } },
    { repairOrderNo: 'RO-FREE', visitDate: d(2026, 5, 20), importedDetails: { workType: 'Free Service' } },
  ];
  assert.equal(findCompletingVisit(due, visits).repairOrderNo, 'RO-FREE');
});

test('completion is not assumed when history cannot establish it', () => {
  const due = d(2026, 5, 10);
  assert.equal(findCompletingVisit(due, []), null);
  assert.equal(findCompletingVisit(due, [{ repairOrderNo: 'A', visitDate: d(2026, 5, 10), importedDetails: { workType: 'Paid Service' } }]), null, 'paid service is not a free service');
  assert.equal(findCompletingVisit(due, [{ repairOrderNo: 'B', visitDate: d(2025, 1, 1), importedDetails: { workType: 'Free Service' } }]), null, 'far from the milestone');
  assert.equal(findCompletingVisit(due, [{ repairOrderNo: 'C', visitDate: null, importedDetails: { workType: 'Free Service' } }]), null, 'undated');
  assert.equal(findCompletingVisit(due, [{ repairOrderNo: 'D', visitDate: d(2026, 5, 10), importedDetails: null }]), null);
});

test('each milestone matches only its own free-service visit', () => {
  const sale = d(2024, 1, 15);
  const visits = [{ repairOrderNo: 'FIRST', visitDate: d(2024, 3, 20), importedDetails: { workType: 'Free Service' } }];
  assert.equal(findCompletingVisit(freeServiceDueDate(sale, 1), visits).repairOrderNo, 'FIRST');
  assert.equal(findCompletingVisit(freeServiceDueDate(sale, 2), visits), null);
  assert.equal(findCompletingVisit(freeServiceDueDate(sale, 3), visits), null);
});

test('remaining free-service count uses sale-date milestones and only matching free repair orders', () => {
  const saleDate = d(2024, 1, 15);
  const visits = [
    { visitDate: d(2024, 4, 10), importedDetails: { workType: 'FOC Service' } },
    { visitDate: d(2025, 1, 20), importedDetails: { workType: 'Paid Service' } },
  ];
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: visits }, d(2026, 10, 30)), 2);

  visits[1].importedDetails.workType = 'Free Service';
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: visits }, d(2026, 10, 30)), 1);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, d(2026, 10, 30)), 3);
});

test('remaining free-service count is unknown without a valid sale date', () => {
  assert.equal(countRemainingFreeServiceMilestones({ saleDate: null, workshopVisits: [] }, d(2026, 10, 30)), null);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate: d(2027, 1, 1), workshopVisits: [] }, d(2026, 10, 30)), null);
});

test('missing, invalid and future sale dates are never substituted', () => {
  const now = d(2026, 10, 27);
  assert.equal(normalizeSaleDate(null, now), null);
  assert.equal(normalizeSaleDate('', now), null);
  assert.equal(normalizeSaleDate('not a date', now), null);
  assert.equal(normalizeSaleDate('2027-01-01', now), null, 'future');
  assert.equal(normalizeSaleDate('15/03/2024', now).getTime(), d(2024, 3, 15).getTime());
  assert.equal(normalizeSaleDate(new Date(2024, 2, 15, 13, 45), now).getTime(), d(2024, 3, 15).getTime(), 'time of day is dropped');
});

test('sale date falls back to repair-order details but never to anything else', () => {
  const now = d(2026, 10, 27);
  assert.equal(resolveSaleDate({ saleDate: d(2024, 1, 5), workshopVisits: [] }, now).getTime(), d(2024, 1, 5).getTime());
  assert.equal(resolveSaleDate({ saleDate: null, workshopVisits: [{ importedDetails: { saleDate: '05/02/2024' } }] }, now).getTime(), d(2024, 2, 5).getTime());
  assert.equal(resolveSaleDate({ saleDate: null, workshopVisits: [{ importedDetails: {} }] }, now), null);
});

test('workload counts a customer once even with several vehicles or milestones in the month', () => {
  const now = d(2026, 10, 27);
  const records = [
    { customerId: 'c1', saleDate: d(2026, 8, 20), workshopVisits: [] }, // first free service due 20 Oct
    { customerId: 'c1', saleDate: d(2025, 10, 5), workshopVisits: [] }, // second free service due 5 Oct
    { customerId: 'c2', saleDate: d(2020, 1, 1), workshopVisits: [] }, // all milestones long past
    { customerId: 'c3', saleDate: null, workshopVisits: [] }, // no sale date
    { customerId: 'c4', saleDate: d(2026, 9, 5), workshopVisits: [] }, // due 5 Nov, calling opens 22 Oct
  ];
  const ids = freeServiceCustomerIdsForMonth(records, 2026, 10, now);
  assert.deepEqual([...ids].sort(), ['c1', 'c4']);
});
