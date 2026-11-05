import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FREE_SERVICE_MILESTONES,
  freeServiceDueDate,
  freeServiceSaleDateRanges,
  isFreeServiceListVisible,
  isWarrantyCallable,
  warrantyExpiryDate,
  warrantySaleDateRange,
} from '../src/utils/serviceCalendar.js';

test('every sale date that is warranty-callable falls inside the SQL pre-filter range', () => {
  let callableCount = 0;
  for (let todayOffset = 0; todayOffset < 800; todayOffset += 7) {
    const today = new Date(2026, 0, 1 + todayOffset);
    const { gte, lt } = warrantySaleDateRange(today);
    for (let saleOffset = -1500; saleOffset < 0; saleOffset += 1) {
      const sale = new Date(today.getFullYear(), today.getMonth(), today.getDate() + saleOffset);
      if (!isWarrantyCallable(warrantyExpiryDate(sale), today)) continue;
      callableCount += 1;
      assert.ok(sale >= gte && sale < lt, `sale ${sale.toISOString()} outside range for today ${today.toISOString()}`);
    }
  }
  assert.ok(callableCount > 0);
});

test('the range is narrow: about one month plus a day of margin each side', () => {
  const { gte, lt } = warrantySaleDateRange(new Date(2026, 10, 4));
  assert.equal((lt - gte) / 86_400_000, 33);
});

test('every visible free-service milestone belongs to a vehicle inside the sale-date ranges', () => {
  let visibleCount = 0;
  for (let todayOffset = 0; todayOffset < 800; todayOffset += 5) {
    const today = new Date(2026, 0, 1 + todayOffset);
    const ranges = freeServiceSaleDateRanges(today);
    for (let saleOffset = -1100; saleOffset < 0; saleOffset += 1) {
      const sale = new Date(today.getFullYear(), today.getMonth(), today.getDate() + saleOffset);
      for (const { milestone } of FREE_SERVICE_MILESTONES) {
        if (!isFreeServiceListVisible(freeServiceDueDate(sale, milestone), today)) continue;
        visibleCount += 1;
        assert.ok(ranges.some(({ gte, lt }) => sale >= gte && sale < lt),
          `sale ${sale.toISOString()} milestone ${milestone} outside ranges for ${today.toISOString()}`);
      }
    }
  }
  assert.ok(visibleCount > 0);
});
