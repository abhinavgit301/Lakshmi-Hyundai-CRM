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
