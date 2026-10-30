import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { exportWorkshopPerformancePdf, exportReportsPdf } from '../src/controllers/pdfExportController.js';
import { prisma } from '../src/config/prisma.js';

function mockRes() {
  const headers = {};
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = function (key, val) { headers[key.toLowerCase()] = val; return this; };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (data) { this.jsonData = data; return this; };

  res.on('finish', () => {
    res.body = Buffer.concat(chunks);
  });

  return res;
}

async function withPrismaMocks(overrides, run) {
  const originals = Object.fromEntries(Object.entries(overrides).map(([path]) => {
    const [model, method] = path.split('.');
    return [path, model === '$queryRaw' ? prisma.$queryRaw : prisma[model][method]];
  }));
  for (const [path, implementation] of Object.entries(overrides)) {
    const [model, method] = path.split('.');
    if (model === '$queryRaw') prisma.$queryRaw = implementation;
    else prisma[model][method] = implementation;
  }
  try {
    await run();
  } finally {
    for (const [path, implementation] of Object.entries(originals)) {
      const [model, method] = path.split('.');
      if (model === '$queryRaw') prisma.$queryRaw = implementation;
      else prisma[model][method] = implementation;
    }
  }
}

const emptyReportDataMocks = {
  'user.findMany': async () => [
    { id: 'ccm-test-1', name: 'Test CCM', role: 'CCM', ccmId: 'ccm-test-1' },
    { id: 'cre-test-1', name: 'Test CRE', role: 'CRE', ccmId: 'ccm-test-1' },
  ],
  'callLog.findMany': async () => [],
  'appointment.findMany': async () => [],
  'masterCallList.groupBy': async () => [],
  '$queryRaw': async () => [],
  'workshopVisit.count': async () => 0,
};

test('exportReportsPdf rejects CCM users with 403 Forbidden', async () => {
  const req = { user: { role: 'CCM', ccmId: 'ccm-1' }, query: {} };
  const res = mockRes();
  await exportReportsPdf(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.jsonData?.message, /only admin and gm/i);
});

test('exportReportsPdf rejects CRE users with 403 Forbidden', async () => {
  const req = { user: { role: 'CRE', id: 'cre-1' }, query: {} };
  const res = mockRes();
  await exportReportsPdf(req, res);
  assert.equal(res.statusCode, 403);
});

test('exportWorkshopPerformancePdf rejects CRE users with 403 Forbidden', async () => {
  const req = { user: { role: 'CRE', id: 'cre-1' }, query: {} };
  const res = mockRes();
  await exportWorkshopPerformancePdf(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.jsonData?.message, /access denied/i);
});

test('exportWorkshopPerformancePdf fails closed for a CCM without ccmId', async () => {
  const req = { user: { role: 'CCM', name: 'Test CCM' }, query: {} };
  const res = mockRes();
  await exportWorkshopPerformancePdf(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.jsonData?.message, /CCM assignment is required/i);
});

test('exportReportsPdf generates a multi-page PDF buffer with correct headers for Admin and GM', async () => {
  const req = {
    user: { role: 'ADMIN', name: 'System Admin' },
    query: { year: '2026', month: '10', tzOffset: '0' },
  };
  const res = mockRes();

  await withPrismaMocks(emptyReportDataMocks, async () => {
    await new Promise((resolve) => {
      res.on('finish', resolve);
      exportReportsPdf(req, res);
    });
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /Reports_.*\.pdf/);
  assert.ok(res.body.length > 500, 'PDF buffer should be non-empty');
  assert.equal(res.body.slice(0, 4).toString(), '%PDF', 'Buffer should begin with %PDF signature');
});

test('exportWorkshopPerformancePdf generates combined 3-chart PDF for CCM scoped to team', async () => {
  const req = {
    user: { role: 'CCM', ccmId: 'ccm-test-1', name: 'Test CCM' },
    query: { serviceType: 'All' },
  };
  const res = mockRes();

  await withPrismaMocks(emptyReportDataMocks, async () => {
    await new Promise((resolve) => {
      res.on('finish', resolve);
      exportWorkshopPerformancePdf(req, res);
    });
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /Workshop_Performance_.*\.pdf/);
  assert.ok(res.body.length > 1000, 'Combined PDF should contain substantial vector & table data');
  assert.equal(res.body.slice(0, 4).toString(), '%PDF', 'Buffer should begin with %PDF signature');
  const pageCount = (res.body.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  assert.equal(pageCount, 3, 'Workshop Performance PDF should contain exactly one page per chart');
});
