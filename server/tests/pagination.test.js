import test from 'node:test';
import assert from 'node:assert/strict';
import { filterServiceListRecords, paginateRecords, parsePagination } from '../src/utils/pagination.js';

test('pagination defaults to 50 and reports whether additional records remain', () => {
  const parsed = parsePagination({ limit: '50', offset: '0' });
  assert.deepEqual(parsed, { limit: 50, offset: 0, hasPagination: true });
  assert.deepEqual(paginateRecords(Array.from({ length: 52 }, (_, id) => ({ id })), parsed), {
    records: Array.from({ length: 50 }, (_, id) => ({ id })),
    total: 52,
    limit: 50,
    offset: 0,
    hasMore: true,
  });
});

test('pagination rejects oversized, fractional, and negative values', () => {
  assert.match(parsePagination({ limit: '51' }).error, /between 1 and 50/);
  assert.match(parsePagination({ limit: '2.5' }).error, /integer/);
  assert.match(parsePagination({ offset: '-1' }).error, /non-negative/);
});

test('service list filtering runs before pagination, including search and due category', () => {
  const filtered = filterServiceListRecords([
    { id: 'old', name: 'Other', dueCategory: '6m' },
    { id: 'match', name: 'Hyundai Customer', dueCategory: '1y' },
    { id: 'wrong-window', name: 'Hyundai Customer', dueCategory: '6m' },
  ], { search: 'hyundai', dueCategory: '1y' });
  assert.deepEqual(filtered.records.map(({ id }) => id), ['match']);
  assert.match(filterServiceListRecords([], { search: 'x'.repeat(201) }).error, /200 characters/);
});

test('service list filters combine milestone, lifecycle status, date ranges, assignee, and follow-up state', () => {
  const records = [
    {
      id: 'grace',
      name: 'Grace Customer',
      milestone: 1,
      graceStatus: 'grace',
      saleDate: new Date(2024, 0, 15),
      dueDate: new Date(2024, 2, 15),
      expiryDate: new Date(2024, 5, 15),
      assigneeId: 'cre-1',
      followUp: { id: 'follow-up-1' },
    },
    {
      id: 'expired',
      name: 'Expired Customer',
      milestone: 1,
      graceStatus: 'expired',
      saleDate: new Date(2024, 0, 15),
      dueDate: new Date(2024, 2, 15),
      expiryDate: new Date(2024, 5, 15),
      assigneeId: 'cre-2',
    },
  ];
  const filtered = filterServiceListRecords(records, {
    milestone: '1',
    graceStatus: 'grace',
    saleFrom: '2024-01-01',
    saleTo: '2024-01-31',
    expiryFrom: '2024-06-01',
    expiryTo: '2024-06-30',
    assigneeId: 'cre-1',
    followUpStatus: 'scheduled',
  });
  assert.deepEqual(filtered.records.map(({ id }) => id), ['grace']);
  assert.equal(filterServiceListRecords(records, { milestone: '1', graceStatus: 'grace', assigneeId: 'cre-1', followUpStatus: 'notScheduled' }).records.length, 0);
  assert.equal(filterServiceListRecords(records, { saleFrom: '2024-02-01', saleTo: '2024-01-01' }).error, 'saleFrom must not be after saleTo.');
});

test('the active grace status combines upcoming and grace records and excludes expired ones', () => {
  const records = [
    { id: 'u', graceStatus: 'upcoming' },
    { id: 'g', graceStatus: 'grace' },
    { id: 'e', graceStatus: 'expired' },
  ];
  assert.deepEqual(filterServiceListRecords(records, { graceStatus: 'active' }).records.map(({ id }) => id), ['u', 'g']);
  assert.equal(filterServiceListRecords(records, { graceStatus: 'bogus' }).error, 'graceStatus is not supported.');
});

test('past-due service filtering is date-based and combines with the cohort', () => {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const records = [
    { id: 'past', dueDate: yesterday, dueCategory: '6m' },
    { id: 'future', dueDate: tomorrow, dueCategory: '6m' },
    { id: 'other', dueDate: yesterday, dueCategory: '1y' },
  ];
  assert.deepEqual(filterServiceListRecords(records, { pastDue: 'true', dueCategory: '6m' }).records.map(({ id }) => id), ['past']);
});
