import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma.js';
import {
  getServiceCategory,
  getWorkshopServicePerformance,
  queryWorkshopServiceData,
  SERVICE_CATEGORIES,
} from '../src/controllers/workshopServicePerformanceController.js';

test('workshop categories use recognized paid services and put PMS in Others', () => {
  const examples = [
    ['Paid Service', 'Paid Service'],
    ['chargeable', 'Paid Service'],
    ['customer pay', 'Paid Service'],
    ['customer-paid', 'Paid Service'],
    ['CP', 'Paid Service'],
    ['PMS', 'Others'],
    ['Periodic maintenance', 'Others'],
    ['Paid PMS', 'Others'],
    ['Free paid service', 'Free Service'],
    ['Paid accident repair', 'Accidental Repair'],
    ['Paid running repair', 'Running Repair'],
    ['FOC', 'Free Service'],
    ['unknown', 'Others'],
    [null, 'Others'],
  ];
  for (const [workType, expected] of examples) {
    assert.equal(getServiceCategory(workType), expected, String(workType));
  }
  assert.deepEqual(SERVICE_CATEGORIES, [
    'Free Service', 'Paid Service', 'Accidental Repair', 'Running Repair', 'Others',
  ]);
});

test('monthly and daily paid and other counts stay separate for all reporting roles and filters', async () => {
  const originalRaw = prisma.$queryRaw;
  const originalCount = prisma.workshopVisit.count;
  const calls = [];
  const visits = [
    { year: 2026, month: 1, day: 2, workType: 'Paid Service', count: 4, ccmId: 'team-a' },
    { year: 2026, month: 1, day: 2, workType: 'PMS', count: 3, ccmId: 'team-a' },
    { year: 2026, month: 1, day: 3, workType: 'FOC', count: 2, ccmId: 'team-a' },
    { year: 2026, month: 1, day: 3, workType: 'chargeable', count: 5, ccmId: 'team-b' },
    { year: 2026, month: 1, day: 3, workType: 'periodic', count: 6, ccmId: 'team-b' },
    { year: 2026, month: 2, day: 4, workType: 'CP', count: 7, ccmId: 'team-a' },
  ];
  prisma.$queryRaw = async (_strings, ...values) => {
    const ccmId = values[2] || null;
    calls.push(ccmId);
    return visits.filter((visit) => !ccmId || visit.ccmId === ccmId);
  };
  prisma.workshopVisit.count = async ({ where }) => (where.visitDate ? 1 : 100);
  const request = async (role, query = {}, ccmId = 'team-a') => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await getWorkshopServicePerformance({
      user: { role, ccmId },
      query: { startMonth: '2026-01', endMonth: '2026-02', ...query },
    }, res);
    return res;
  };
  try {
    for (const role of ['ADMIN', 'GM', 'CCM']) {
      const response = await request(role, { serviceType: 'Paid Service', ccmId: 'team-b' });
      assert.equal(response.statusCode, 200);
      assert.equal(calls.at(-1), role === 'CCM' ? 'team-a' : 'team-b');
      const teamA = role === 'CCM';
      assert.equal(response.body.filteredRangeCount, teamA ? 11 : 5);
      assert.equal(response.body.months[0].categories['Paid Service'], teamA ? 4 : 5);
      assert.equal(response.body.months[0].categories.Others, teamA ? 3 : 6);
      assert.equal(response.body.months[1].categories['Paid Service'], teamA ? 7 : 0);
      assert.equal(response.body.daily[0].categories['Paid Service'], teamA ? 4 : 5);
      assert.equal(response.body.daily[0].categories.Others, teamA ? 3 : 6);
      assert.equal('PMS' in response.body.months[0].categories, false);
    }

    const allTeams = await request('ADMIN', { serviceType: 'Others' });
    assert.equal(allTeams.body.rangeCount, 27);
    assert.equal(allTeams.body.filteredRangeCount, 9);
    assert.equal(allTeams.body.months[0].categories['Paid Service'], 9);
    assert.equal(allTeams.body.months[0].categories.Others, 9);
    assert.equal((await request('ADMIN', { serviceType: 'PMS' })).statusCode, 400);

    const all = await queryWorkshopServiceData({ startMonth: '2026-01', endMonth: '2026-02' });
    assert.equal(all.filteredRangeCount, all.rangeCount);
    for (const month of all.months) {
      assert.equal(Object.values(month.categories).reduce((sum, count) => sum + count, 0), month.total);
    }
  } finally {
    prisma.$queryRaw = originalRaw;
    prisma.workshopVisit.count = originalCount;
  }
});
