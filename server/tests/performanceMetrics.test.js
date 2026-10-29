import test from 'node:test';
import assert from 'node:assert/strict';
import { appointmentConversionRatePercent } from '../src/utils/performanceMetrics.js';

test('appointment conversion rate uses lifetime appointment and call totals', () => {
  assert.equal(appointmentConversionRatePercent(18, 100), 18);
});

test('appointment conversion rate is zero when no calls were logged', () => {
  assert.equal(appointmentConversionRatePercent(0, 0), 0);
  assert.equal(appointmentConversionRatePercent(4, 0), 0);
});

test('appointment conversion rate is not capped at 100 percent', () => {
  assert.equal(appointmentConversionRatePercent(3, 2), 150);
});
