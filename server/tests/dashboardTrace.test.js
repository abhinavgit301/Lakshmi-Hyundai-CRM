import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardTrace, traceDashboardPhase } from '../src/utils/dashboardTrace.js';
import { isDashboardSlimCallListEnabled } from '../src/controllers/recordsController.js';

test('dashboard diagnostics and slim loader are opt-in', () => {
  for (const value of [undefined, '', 'false', 'yes']) {
    assert.equal(createDashboardTrace({ DASHBOARD_TIMING_LOG: value }), null);
    assert.equal(isDashboardSlimCallListEnabled({ DASHBOARD_SLIM_CALL_LIST_ENABLED: value }), false);
  }
  for (const value of ['true', '1', ' TRUE ']) {
    assert.equal(isDashboardSlimCallListEnabled({ DASHBOARD_SLIM_CALL_LIST_ENABLED: value }), true);
  }
  assert.ok(createDashboardTrace({ DASHBOARD_TIMING_LOG: ' TRUE ' }));
});

test('dashboard timings record success and failure without swallowing errors or logging inputs', async (t) => {
  const entries = [];
  t.mock.method(console, 'info', (message) => entries.push(JSON.parse(message)));
  const trace = createDashboardTrace({ DASHBOARD_TIMING_LOG: 'true' });
  assert.equal(await traceDashboardPhase(trace, 'general_counts', async () => 42), 42);
  const failure = new Error('sensitive database error');
  await assert.rejects(traceDashboardPhase(trace, 'call_list', async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(entries.map(({ event, phase, outcome }) => [event, phase, outcome]), [
    ['phase_start', 'general_counts', undefined],
    ['phase_end', 'general_counts', 'ok'],
    ['phase_start', 'call_list', undefined],
    ['phase_end', 'call_list', 'error'],
  ]);
  assert.equal(new Set(entries.map(({ requestId }) => requestId)).size, 1);
  assert.ok(!JSON.stringify(entries).includes(failure.message));
});

test('disabled diagnostics run work and propagate failures', async () => {
  assert.equal(await traceDashboardPhase(null, 'test', () => 7), 7);
  const failure = new Error('failure');
  await assert.rejects(traceDashboardPhase(null, 'test', () => { throw failure; }), (error) => error === failure);
});
