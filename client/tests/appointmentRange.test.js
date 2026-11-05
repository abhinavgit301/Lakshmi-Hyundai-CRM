import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appointmentWindowFor,
  fetchAppointmentWindow,
  isInWindow,
  upcomingDayKeys,
} from '../src/lib/appointmentRange.js';

test('upcomingDayKeys spans month and year boundaries in local time', () => {
  assert.deepEqual(
    upcomingDayKeys(7, new Date(2026, 11, 29, 23, 30)),
    ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'],
  );
  assert.deepEqual(upcomingDayKeys(3, new Date(2028, 1, 28)), ['2028-02-28', '2028-02-29', '2028-03-01']);
});

test('window covers the whole first and last visible local day, end exclusive', () => {
  const window = appointmentWindowFor(['2026-01-29', '2026-02-04', '2026-01-30']);
  assert.equal(window.key, '2026-01-29..2026-02-04');
  assert.equal(window.fromMs, new Date(2026, 0, 29, 0, 0, 0, 0).getTime());
  assert.equal(window.toMs, new Date(2026, 1, 5, 0, 0, 0, 0).getTime());
  assert.equal(window.from, new Date(window.fromMs).toISOString());
  assert.equal(window.to, new Date(window.toMs).toISOString());
  assert.equal(isInWindow(window, new Date(2026, 0, 29, 0, 0, 0, 0)), true);
  assert.equal(isInWindow(window, new Date(2026, 1, 4, 23, 59, 59, 999)), true);
  assert.equal(isInWindow(window, new Date(2026, 1, 5, 0, 0, 0, 0)), false);
  assert.equal(isInWindow(window, new Date(2026, 0, 28, 23, 59, 59, 999)), false);
  assert.equal(isInWindow(null, new Date()), false);
});

test('a selected day outside the strip widens the window to include it', () => {
  const window = appointmentWindowFor([...upcomingDayKeys(7, new Date(2026, 5, 10)), '2026-06-09']);
  assert.equal(window.key, '2026-06-09..2026-06-16');
});

function pagedServer(total) {
  const requests = [];
  const rows = Array.from({ length: total }, (_, index) => ({ id: `a${index}` }));
  const get = async (url, options) => {
    const params = new URL(url, 'http://x').searchParams;
    requests.push({ params, signal: options?.signal });
    const offset = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    const batch = rows.slice(offset, offset + limit);
    return { data: { appointments: batch, total, hasMore: offset + batch.length < total } };
  };
  return { get, requests };
}

test('fetchAppointmentWindow loads every page of the range with from/to on each request', async () => {
  const window = appointmentWindowFor(['2026-03-01', '2026-03-07']);
  const server = pagedServer(120);
  const { rows, truncated } = await fetchAppointmentWindow(server.get, window, { pageSize: 50 });
  assert.equal(rows.length, 120);
  assert.equal(truncated, false);
  assert.deepEqual(server.requests.map((request) => request.params.get('offset')), ['0', '50', '100']);
  for (const request of server.requests) {
    assert.equal(request.params.get('from'), window.from);
    assert.equal(request.params.get('to'), window.to);
    assert.equal(request.params.get('limit'), '50');
  }
});

test('an empty range makes one request and returns no rows', async () => {
  const server = pagedServer(0);
  const { rows } = await fetchAppointmentWindow(server.get, appointmentWindowFor(['2026-03-01']));
  assert.equal(rows.length, 0);
  assert.equal(server.requests.length, 1);
});

test('rows repeated across pages by a concurrent change are de-duplicated', async () => {
  let call = 0;
  const get = async () => {
    call += 1;
    return call === 1
      ? { data: { appointments: [{ id: 'a' }, { id: 'b' }], hasMore: true } }
      : { data: { appointments: [{ id: 'b' }, { id: 'c' }], hasMore: false } };
  };
  const { rows } = await fetchAppointmentWindow(get, appointmentWindowFor(['2026-03-01']), { pageSize: 2 });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
});

test('the page bound is reported as truncation instead of silently dropping rows', async () => {
  const server = pagedServer(500);
  const { rows, truncated } = await fetchAppointmentWindow(server.get, appointmentWindowFor(['2026-03-01']), { pageSize: 10, maxPages: 3 });
  assert.equal(rows.length, 30);
  assert.equal(truncated, true);
});

test('the abort signal reaches every request and a canceled load rejects', async () => {
  const controller = new AbortController();
  const seen = [];
  const get = async (url, { signal }) => {
    seen.push(signal);
    if (signal.aborted) throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
    controller.abort();
    return { data: { appointments: [{ id: 'a' }], hasMore: true } };
  };
  await assert.rejects(
    fetchAppointmentWindow(get, appointmentWindowFor(['2026-03-01']), { signal: controller.signal }),
    (error) => error.code === 'ERR_CANCELED',
  );
  assert.equal(seen.length, 2);
  assert.ok(seen.every((signal) => signal === controller.signal));
});
