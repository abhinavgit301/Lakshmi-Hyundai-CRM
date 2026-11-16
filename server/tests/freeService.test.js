import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countRemainingFreeServiceMilestones,
  classifyFreeServiceStatus,
  freeServiceVisitsByMilestone,
  freeServiceCallStart,
  freeServiceCustomerIdsForMonth,
  freeServiceDueDate,
  freeServiceExpiryDate,
  isFreeServiceListVisible,
  isFreeServiceCallable,
  normalizeSaleDate,
  resolveSaleDate,
} from '../src/utils/serviceCalendar.js';
import { addMonths } from '../src/utils/serviceDue.js';

const d = (year, month, day) => new Date(year, month - 1, day);

test('early Free Service visit completes the first milestone and leaves two services', () => {
  const saleDate = d(2026, 10, 10);
  const visit = { id: 'early', visitDate: d(2026, 10, 31), importedDetails: { serviceType: 'Free Service' } };
  const now = d(2026, 11, 15);
  assert.equal(freeServiceVisitsByMilestone(saleDate, [visit], now).get(1), visit);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [visit] }, now), 2);
  assert.deepEqual([...freeServiceCustomerIdsForMonth([
    { customerId: 'customer', saleDate, workshopVisits: [visit] },
  ], 2026, 12, now)], []);
  assert.deepEqual([...freeServiceCustomerIdsForMonth([
    { customerId: 'customer', saleDate, workshopVisits: [visit] },
  ], 2027, 10, d(2027, 10, 1))], ['customer']);
});

test('free visits are assigned once in date order, including late visits after missed milestones', () => {
  const sale = d(2026, 1, 1);
  const first = { id: 'first', visitDate: d(2027, 1, 3), importedDetails: { workType: 'Free Service' } };
  const second = { id: 'second', visitDate: d(2027, 2, 1), importedDetails: { workType: 'FOC Service' } };
  const future = { id: 'future', visitDate: d(2027, 4, 1), importedDetails: { workType: 'Free Service' } };
  const beforeSale = { id: 'before', visitDate: d(2025, 12, 31), importedDetails: { workType: 'Free Service' } };
  const undated = { id: 'undated', importedDetails: { workType: 'Free Service' } };
  const assignments = freeServiceVisitsByMilestone(sale, [second, first, future, beforeSale, undated, first], d(2027, 3, 1));
  assert.deepEqual([...assignments.entries()], [[2, first], [3, second]]);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate: sale, workshopVisits: [second, first, future] }, d(2027, 3, 1)), 0);
});

test('expiry day remains eligible; the next day skips the expired milestone', () => {
  const saleDate = d(2026, 1, 10);
  const visit = (id, date, ccmId = 'a') => ({ id, ccmId, visitDate: date, importedDetails: { workType: 'Free Service' } });
  const expiry = d(2026, 6, 10);
  const onExpiry = visit('a', expiry);
  const afterExpiry = visit('b', d(2026, 6, 11));
  assert.equal(freeServiceVisitsByMilestone(saleDate, [onExpiry], expiry).get(1), onExpiry);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, expiry), 3);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, afterExpiry.visitDate), 2);
  assert.equal(freeServiceVisitsByMilestone(saleDate, [afterExpiry], afterExpiry.visitDate).get(2), afterExpiry);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [afterExpiry] }, afterExpiry.visitDate), 1);
  afterExpiry.repairOrderNo = 'RO-1';
  const otherCcm = { ...visit('c', d(2026, 6, 11), 'b'), repairOrderNo: 'RO-1' };
  assert.deepEqual([...freeServiceVisitsByMilestone(saleDate, [afterExpiry, otherCcm], otherCcm.visitDate).keys()], [2, 3]);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [afterExpiry, otherCcm] }, otherCcm.visitDate), 0);
  assert.equal(freeServiceVisitsByMilestone(saleDate, [visit('late', d(2029, 1, 1))], d(2029, 1, 1)).size, 0);
});

test('month-end expiry is inclusive when assigning visits', () => {
  const saleDate = d(2023, 12, 31);
  const expiry = d(2024, 5, 29);
  const first = { id: 'on', visitDate: expiry, importedDetails: { workType: 'Free Service' } };
  const second = { id: 'after', visitDate: d(2024, 5, 30), importedDetails: { workType: 'Free Service' } };
  assert.equal(freeServiceVisitsByMilestone(saleDate, [first], expiry).get(1), first);
  assert.equal(freeServiceVisitsByMilestone(saleDate, [second], second.visitDate).get(2), second);
});

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

test('free-service grace status begins on the milestone and expires three months later', () => {
  for (const milestone of [1, 2, 3]) {
    const sale = d(2024, 1, 31);
    const due = freeServiceDueDate(sale, milestone);
    const expiry = freeServiceExpiryDate(due);
    assert.equal(expiry.getTime(), addMonths(due, 3).getTime());
    assert.equal(classifyFreeServiceStatus(due, d(due.getFullYear(), due.getMonth() + 1, due.getDate() - 1)), 'upcoming');
    assert.equal(classifyFreeServiceStatus(due, due), 'grace');
    assert.equal(classifyFreeServiceStatus(due, expiry), 'grace');
    assert.equal(classifyFreeServiceStatus(due, d(expiry.getFullYear(), expiry.getMonth() + 1, expiry.getDate() + 1)), 'expired');
  }
});

test('free-service expiry clamps consistently at month ends and leap years', () => {
  assert.equal(freeServiceExpiryDate(d(2024, 2, 29)).getTime(), d(2024, 5, 29).getTime());
  assert.equal(freeServiceExpiryDate(d(2024, 11, 30)).getTime(), d(2025, 2, 28).getTime());
  assert.equal(freeServiceExpiryDate(d(2023, 11, 30)).getTime(), d(2024, 2, 29).getTime());
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

test('free-service list shows pre-due and grace milestones and drops them once the grace period ends', () => {
  const due = d(2026, 12, 15);
  const expiry = freeServiceExpiryDate(due);
  assert.equal(isFreeServiceListVisible(due, d(2026, 11, 30)), false);
  assert.equal(isFreeServiceListVisible(due, d(2026, 12, 1)), true);
  assert.equal(isFreeServiceListVisible(due, due), true);
  assert.equal(isFreeServiceListVisible(due, d(2027, 1, 1)), true);
  assert.equal(isFreeServiceListVisible(due, expiry), true, 'expiry day is the last grace day');
  assert.equal(isFreeServiceListVisible(due, d(2027, 3, 16)), false, 'expired milestones leave the list');
  assert.equal(isFreeServiceListVisible(d(2027, 1, 15), d(2026, 12, 15)), false);
  assert.equal(classifyFreeServiceStatus(due, expiry), 'grace');
});

test('the due date must fall within the next rolling calendar month, inclusive', () => {
  // Calling window opens 14 days earlier, so the one-month ceiling is only reached by the due date itself.
  assert.equal(isFreeServiceCallable(d(2027, 1, 31), d(2026, 12, 31)), false);
  // Calendar-month arithmetic, not 30 days: 31 Jan + 1 month clamps to 28 Feb.
  assert.equal(isFreeServiceCallable(d(2026, 2, 28), d(2026, 1, 31)), false, 'before 14-day calling start');
  assert.equal(isFreeServiceCallable(d(2026, 2, 10), d(2026, 1, 31)), true);
});

test('paid-service history permanently ends remaining free-service eligibility', () => {
  const saleDate = d(2024, 1, 15);
  const visits = [
    { visitDate: d(2024, 4, 10), importedDetails: { workType: 'FOC Service' } },
    { visitDate: d(2025, 1, 20), importedDetails: { workType: 'Paid Service' } },
  ];
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: visits }, d(2025, 2, 1)), 0);

  visits[1].importedDetails.workType = 'Free Service';
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: visits }, d(2025, 2, 1)), 1);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, d(2024, 5, 1)), 3);
});

test('expired free-service milestones are not remaining whether or not the customer came', () => {
  const saleDate = d(2020, 3, 6);
  const visits = [
    { visitDate: d(2020, 12, 20), importedDetails: { workType: 'Free Service' } },
    { visitDate: d(2021, 2, 17), importedDetails: { workType: 'Free Service' } },
  ];
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: visits }, d(2026, 11, 1)), 0);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, d(2026, 11, 1)), 0);
  // 5 months after sale the first milestone is expired; the other two are still open.
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, d(2020, 8, 7)), 2);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, d(2020, 8, 6)), 3);
});

test('a grace-period free service reduces the available milestone count', () => {
  const saleDate = d(2026, 1, 15);
  const firstServiceDue = freeServiceDueDate(saleDate, 1);
  const visit = {
    visitDate: d(firstServiceDue.getFullYear(), firstServiceDue.getMonth() + 2, firstServiceDue.getDate()),
    importedDetails: { workType: 'Free Service' },
  };
  const now = d(2026, 6, 1);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [] }, now), 3);
  assert.equal(countRemainingFreeServiceMilestones({ saleDate, workshopVisits: [visit] }, now), 2);
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
