import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  assertProcessMatchesWorkshopTimezone,
  canonicalTimezone,
  canonicalWorkshopTimezone,
} from '../src/utils/workshopTime.js';

const same = (a, b) => assert.equal(canonicalTimezone(a), canonicalTimezone(b), `${a} should match ${b}`);
const different = (a, b) => assert.notEqual(canonicalTimezone(a), canonicalTimezone(b), `${a} should not match ${b}`);

test('equivalent timezone aliases canonicalise to the same identifier', () => {
  same('Asia/Kolkata', 'Asia/Calcutta');
  same('Asia/Calcutta', 'Asia/Kolkata');
  same('UTC', 'Etc/UTC');
  same('America/New_York', 'US/Eastern');
});

test('genuinely different timezones do not match', () => {
  different('Asia/Kolkata', 'UTC');
  different('Asia/Kolkata', 'Asia/Dhaka');
  different('Asia/Kolkata', 'Asia/Kathmandu');
});

test('invalid identifiers, abbreviations and numeric offsets are rejected', () => {
  for (const value of ['Asia/Kolkatta', 'Not/AZone', 'IST', 'EST', '+05:30', '-0500', 'UTC+5', '', ' ', undefined, null, 5]) {
    assert.throws(() => canonicalTimezone(value), /time zone/i, `${JSON.stringify(value)} should be rejected`);
  }
});

function withEnv(values, fn) {
  const saved = process.env.WORKSHOP_TIMEZONE;
  if (values === undefined) delete process.env.WORKSHOP_TIMEZONE; else process.env.WORKSHOP_TIMEZONE = values;
  try { return fn(); } finally { if (saved === undefined) delete process.env.WORKSHOP_TIMEZONE; else process.env.WORKSHOP_TIMEZONE = saved; }
}

test('guard accepts equivalent aliases between configuration and process timezone', () => {
  const ok = withEnv('Asia/Kolkata', () => assertProcessMatchesWorkshopTimezone('Asia/Calcutta'));
  assert.equal(ok.configured, 'Asia/Kolkata');
  assert.equal(ok.effective, 'Asia/Calcutta');
  assert.equal(ok.canonical, canonicalTimezone('Asia/Kolkata'));
  withEnv('Asia/Calcutta', () => assertProcessMatchesWorkshopTimezone('Asia/Kolkata'));
  withEnv('Etc/UTC', () => assertProcessMatchesWorkshopTimezone('UTC'));
});

test('guard defaults WORKSHOP_TIMEZONE to Asia/Kolkata when unset', () => {
  withEnv(undefined, () => {
    assert.equal(canonicalWorkshopTimezone(), canonicalTimezone('Asia/Kolkata'));
    assertProcessMatchesWorkshopTimezone('Asia/Calcutta');
  });
});

test('guard fails with a clear message when the process timezone differs', () => {
  withEnv('Asia/Kolkata', () => {
    assert.throws(() => assertProcessMatchesWorkshopTimezone('UTC'), /WORKSHOP_TIMEZONE is "Asia\/Kolkata".*"UTC".*TZ=Asia\/Kolkata/);
    assert.throws(() => assertProcessMatchesWorkshopTimezone('Asia/Dhaka'), /mismatch/i);
  });
});

test('guard fails on an invalid configured timezone', () => {
  for (const bad of ['IST', '+05:30', 'Asia/Nowhere']) {
    withEnv(bad, () => assert.throws(() => assertProcessMatchesWorkshopTimezone('Asia/Calcutta'), /time zone/i));
  }
});

test('a real process started in the wrong timezone fails the guard, and one in the right timezone passes', () => {
  const module = pathToFileURL(path.resolve('src/utils/workshopTime.js')).href;
  const script = `import(${JSON.stringify(module)}).then((m) => { console.log(JSON.stringify(m.assertProcessMatchesWorkshopTimezone())); }).catch((e) => { console.error(e.message); process.exit(1); });`;
  const run = (tz) => spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz, WORKSHOP_TIMEZONE: 'Asia/Kolkata' }, encoding: 'utf8',
  });
  const wrong = run('UTC');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Timezone mismatch/);
  const right = run('Asia/Kolkata');
  assert.equal(right.status, 0, right.stderr);
  assert.equal(JSON.parse(right.stdout).configured, 'Asia/Kolkata');
});
