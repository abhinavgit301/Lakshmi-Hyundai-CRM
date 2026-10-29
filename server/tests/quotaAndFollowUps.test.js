import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_TARGETS,
  FOLLOW_UP_SOURCE_BY_LIST,
  buildQuotaNotifications,
  buildQuotaRows,
  evaluateQuota,
  isAnsweredOutcome,
  routeFollowUpSource,
} from '../src/utils/serviceCalendar.js';
import { parseDateKey, workshopDayRange, zonedDateKey } from '../src/utils/workshopTime.js';
import { validateCallLogPayload, validateFollowUpPayload } from '../src/utils/workflowRules.js';

const TZ = 'Asia/Kolkata';

test('daily targets are 120 calls made and 80 calls picked up', () => {
  assert.deepEqual(DAILY_TARGETS, { callsMade: 120, callsPickedUp: 80 });
});

test('actuals can exceed targets and are never capped', () => {
  const result = evaluateQuota({ callsMade: 150, callsPickedUp: 79 });
  assert.equal(result.callsMade, 150);
  assert.equal(result.callsMadeMet, true);
  assert.equal(result.callsMadeShortfall, 0);
  assert.equal(result.callsPickedUp, 79);
  assert.equal(result.callsPickedUpMet, false);
  assert.equal(result.callsPickedUpShortfall, 1);
});

test('a call is picked up unless nobody answered or the number was wrong', () => {
  for (const outcome of ['CONTACTED', 'CALLBACK', 'NOT_INTERESTED', 'APPOINTMENT_SET', 'FOLLOW_UP_LATER', 'OTHER']) assert.equal(isAnsweredOutcome(outcome), true, outcome);
  for (const outcome of ['NO_RESPONSE', 'WRONG_NUMBER', null, undefined]) assert.equal(isAnsweredOutcome(outcome), false, String(outcome));
});

const counts = new Map([
  ['a', { callsMade: 150, callsPickedUp: 79 }],
  ['b', { callsMade: 105, callsPickedUp: 62 }],
  ['c', { callsMade: 120, callsPickedUp: 85 }],
  ['d', { callsMade: 110, callsPickedUp: 85 }],
  ['e', { callsMade: 160, callsPickedUp: 95 }],
]);
const cres = [
  { id: 'a', name: 'CRE A' }, { id: 'b', name: 'CRE B' }, { id: 'c', name: 'CRE C' }, { id: 'd', name: 'CRE D' }, { id: 'e', name: 'CRE E' }, { id: 'z', name: 'CRE Z' },
];

test('the board has a row per CRE with zero-call CREs shown as 0 / 120 and 0 / 80', () => {
  const rows = buildQuotaRows(cres, counts);
  assert.equal(rows.length, 6);
  const zero = rows.find((row) => row.creId === 'z');
  assert.deepEqual([zero.callsMade, zero.callsMadeTarget, zero.callsPickedUp, zero.callsPickedUpTarget], [0, 120, 0, 80]);
  assert.equal(zero.callsMadeMet, false);
  assert.equal(zero.callsPickedUpMet, false);
});

test('each target is evaluated independently on the board', () => {
  const rows = buildQuotaRows(cres, counts);
  const status = (id) => { const row = rows.find((entry) => entry.creId === id); return [row.callsMadeMet, row.callsPickedUpMet]; };
  assert.deepEqual(status('a'), [true, false], 'met made, missed picked up');
  assert.deepEqual(status('b'), [false, false], 'missed both');
  assert.deepEqual(status('c'), [true, true], 'met both at exactly the target');
  assert.deepEqual(status('d'), [false, true]);
  assert.deepEqual(status('e'), [true, true]);
});

test('notifications list each missed target separately with the shortfall', () => {
  const rows = buildQuotaRows(cres, counts);
  const { callsMadeMissed, callsPickedUpMissed } = buildQuotaNotifications(rows);
  assert.deepEqual(callsMadeMissed.map((entry) => entry.creId), ['b', 'd', 'z']);
  assert.deepEqual(callsPickedUpMissed.map((entry) => entry.creId), ['a', 'b', 'z']);
  assert.deepEqual(callsMadeMissed.find((entry) => entry.creId === 'd'), { creId: 'd', creName: 'CRE D', actual: 110, target: 120, shortfall: 10 });
  assert.deepEqual(callsPickedUpMissed.find((entry) => entry.creId === 'a'), { creId: 'a', creName: 'CRE A', actual: 79, target: 80, shortfall: 1 });
});

test('a CRE missing both targets is in both modules and one meeting both is in neither', () => {
  const { callsMadeMissed, callsPickedUpMissed } = buildQuotaNotifications(buildQuotaRows(cres, counts));
  const both = (list, id) => list.some((entry) => entry.creId === id);
  assert.equal(both(callsMadeMissed, 'b') && both(callsPickedUpMissed, 'b'), true);
  assert.equal(both(callsMadeMissed, 'c') || both(callsPickedUpMissed, 'c'), false);
  assert.equal(both(callsMadeMissed, 'e') || both(callsPickedUpMissed, 'e'), false);
});

test('notifications and the board use identical numbers', () => {
  const rows = buildQuotaRows(cres, counts);
  const { callsMadeMissed, callsPickedUpMissed } = buildQuotaNotifications(rows);
  for (const entry of callsMadeMissed) assert.equal(entry.actual, rows.find((row) => row.creId === entry.creId).callsMade);
  for (const entry of callsPickedUpMissed) assert.equal(entry.actual, rows.find((row) => row.creId === entry.creId).callsPickedUp);
});

test('when every CRE meets a target its module is empty', () => {
  const met = buildQuotaRows([{ id: 'a', name: 'A' }], new Map([['a', { callsMade: 200, callsPickedUp: 100 }]]));
  const notifications = buildQuotaNotifications(met);
  assert.deepEqual(notifications.callsMadeMissed, []);
  assert.deepEqual(notifications.callsPickedUpMissed, []);
});

test('the previous reporting day is the previous completed calendar day in the workshop timezone', () => {
  // 27 Oct 2026 20:00 UTC is already 28 Oct 01:30 in Kolkata, so "yesterday" is 27 Oct, not 26 Oct.
  const range = workshopDayRange(new Date('2026-10-27T20:00:00Z'), -1, TZ);
  assert.equal(range.dateKey, '2026-10-27');
  assert.equal(range.start.toISOString(), '2026-10-26T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-27T18:30:00.000Z');
  const today = workshopDayRange(new Date('2026-10-27T20:00:00Z'), 0, TZ);
  assert.equal(today.dateKey, '2026-10-28');
  assert.equal(today.start.getTime(), range.end.getTime(), 'no gap or overlap between days');
});

test('day boundaries follow daylight saving changes', () => {
  const ny = 'America/New_York';
  const range = workshopDayRange(new Date('2026-11-01T12:00:00Z'), 0, ny);
  assert.equal(range.dateKey, '2026-11-01');
  assert.equal((range.end - range.start) / 3600000, 25, 'the day the clocks go back is 25 hours long');
});

test('date keys round-trip and invalid dates are rejected', () => {
  assert.equal(parseDateKey('2026-10-27', TZ).dateKey, '2026-10-27');
  assert.equal(parseDateKey('2026-02-30', TZ), null);
  assert.equal(parseDateKey('27/10/2026', TZ), null);
  assert.equal(zonedDateKey(new Date('2026-10-27T20:00:00Z'), TZ), '2026-10-28');
});

test('follow-ups route by their originating list', () => {
  assert.equal(routeFollowUpSource('1y'), 'SERVICE');
  assert.equal(routeFollowUpSource('6m'), 'SERVICE');
  assert.equal(routeFollowUpSource('free'), 'FREE_SERVICE');
  assert.equal(routeFollowUpSource('warranty'), 'WARRANTY');
  assert.equal(routeFollowUpSource('anything else'), 'SERVICE');
  assert.deepEqual(Object.keys(FOLLOW_UP_SOURCE_BY_LIST).sort(), ['1y', '6m', 'free', 'warranty']);
});

test('call logs default to the service source and validate the source', () => {
  const base = { customerId: 'c1', outcome: 'CONTACTED' };
  assert.equal(validateCallLogPayload(base).value.callSource, 'SERVICE');
  assert.equal(validateCallLogPayload({ ...base, callSource: 'bogus' }).error, 'Call source is invalid.');
});

test('warranty and free-service calls must name the vehicle that the case belongs to', () => {
  const base = { customerId: 'c1', outcome: 'CONTACTED' };
  assert.match(validateCallLogPayload({ ...base, callSource: 'WARRANTY' }).error, /vehicle is required/);
  assert.equal(validateCallLogPayload({ ...base, callSource: 'WARRANTY', vehicleId: 'v1' }).value.callSource, 'WARRANTY');
  assert.match(validateCallLogPayload({ ...base, callSource: 'FREE_SERVICE', vehicleId: 'v1' }).error, /milestone/);
  const free = validateCallLogPayload({ ...base, callSource: 'FREE_SERVICE', vehicleId: 'v1', milestoneId: 'm1' }).value;
  assert.equal(free.milestoneId, 'm1');
  assert.equal(validateCallLogPayload({ ...base, callSource: 'SERVICE', vehicleId: 'v1', milestoneId: 'm1' }).value.milestoneId, null, 'milestones only attach to free-service calls');
});

test('follow-ups carry their source, vehicle and milestone', () => {
  const value = validateFollowUpPayload({ customerId: 'c1', category: 'FOLLOW_UP_LATER', followUpAt: '2026-11-05T10:00:00Z', source: 'free_service', vehicleId: 'v1', milestoneId: 'm1' }).value;
  assert.equal(value.source, 'FREE_SERVICE');
  assert.equal(value.vehicleId, 'v1');
  assert.equal(value.milestoneId, 'm1');
  assert.equal(validateFollowUpPayload({ customerId: 'c1', category: 'X', followUpAt: '2026-11-05T10:00:00Z' }).value.source, 'SERVICE');
  assert.equal(validateFollowUpPayload({ customerId: 'c1', category: 'X', followUpAt: '2026-11-05T10:00:00Z', source: 'nope' }).error, 'Follow-up source is invalid.');
});
