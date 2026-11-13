import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { prisma } from '../src/config/prisma.js';
import { exportWorkshopPerformancePdf } from '../src/controllers/pdfExportController.js';

test('workshop PDF displays paid counts rather than PMS for Admin, GM and CCM', async () => {
  const originalRaw = prisma.$queryRaw;
  const originalCount = prisma.workshopVisit.count;
  const originalText = PDFDocument.prototype.text;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const observations = [
    { year, month, day: 1, workType: 'Paid Service', count: 11, ccmId: 'team-a' },
    { year, month, day: 1, workType: 'PMS', count: 3, ccmId: 'team-a' },
    { year: year - 2, month, day: 1, workType: 'chargeable', count: 7, ccmId: 'team-a' },
    { year: year - 2, month, day: 1, workType: 'Periodic', count: 2, ccmId: 'team-a' },
  ];
  const textCalls = [];
  prisma.$queryRaw = async (_strings, start, end, ccmId) => observations.filter((row) => {
    const date = new Date(row.year, row.month - 1, row.day);
    return date >= start && date < end && (!ccmId || row.ccmId === ccmId);
  });
  prisma.workshopVisit.count = async () => 0;
  PDFDocument.prototype.text = function (text, ...args) {
    textCalls.push(String(text));
    return originalText.call(this, text, ...args);
  };
  try {
    for (const role of ['ADMIN', 'GM', 'CCM']) {
      textCalls.length = 0;
      const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      response.setHeader = () => {};
      response.status = (code) => { throw new Error(`Unexpected PDF response status ${code}`); };
      const finished = new Promise((resolve, reject) => {
        response.on('finish', resolve);
        response.on('error', reject);
      });
      await exportWorkshopPerformancePdf({
        user: { role, ccmId: 'team-a' },
        query: {
          serviceType: 'Paid Service',
          analysisPeriod: 'month', analysisYear: String(year), analysisMonth: String(month),
          analysisCompareYear: String(year - 2), analysisCompareMonth: String(month),
          mtdPeriod: `${year}-${String(month).padStart(2, '0')}`,
          mtdComparisonYear: String(year - 2),
        },
      }, response);
      await finished;
      assert.ok(textCalls.includes('Paid Service'), role);
      assert.ok(!textCalls.includes('PMS'), role);
      assert.ok(textCalls.includes('All Teams Combined | Service Type: Paid Service')
        || textCalls.includes('CCM Team: team-a | Service Type: Paid Service'), role);
      assert.ok(textCalls.some((text, index) => text === 'Paid Service'
        && textCalls[index + 1] === '7' && textCalls[index + 2] === '11'), role);
      const monthLabel = new Date(`${year}-${String(month).padStart(2, '0')}-01`)
        .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      assert.ok(textCalls.some((text, index) => text === monthLabel
        && textCalls[index + 1] === '11' && textCalls[index + 2] === '0'
        && textCalls[index + 3] === '11'), `paid trend table values: ${role}`);
      const dayIndex = textCalls.findIndex((text) => text.startsWith('Day 1 (Current)'));
      const cutoffIndex = textCalls.findIndex((text) => text.startsWith(`Day ${now.getDate()} (Current)`));
      const index = dayIndex >= 0 ? dayIndex : cutoffIndex;
      assert.ok(index >= 0, 'MTD table contains the equivalent-day result');
      assert.deepEqual(textCalls.slice(index + 1, index + 3), ['7', '11'], role);
      assert.ok(textCalls.includes(`${year - 2} Cumulative`), role);
    }
  } finally {
    prisma.$queryRaw = originalRaw;
    prisma.workshopVisit.count = originalCount;
    PDFDocument.prototype.text = originalText;
  }
});
