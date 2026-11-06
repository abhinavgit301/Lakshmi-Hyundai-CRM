// Read-only controller-level comparison for the legacy and aggregate performance paths.
//
//   node scripts/performance/benchmark-performance-endpoints.mjs [--iterations 20]
//
// Uses only the guarded local bench connection. The aggregate migration must already be present,
// counters must be backfilled, and the current-month CRE and FREE_SERVICE_CRE snapshots must be fresh.
import { performance } from 'node:perf_hooks';
import { startScript } from './perf-db.mjs';

const iterations = Number(process.argv[process.argv.indexOf('--iterations') + 1] || 20);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200) {
  console.error('benchmark-performance-endpoints: --iterations must be between 1 and 200');
  process.exit(2);
}

process.env.CALL_LIST_CACHE_TTL_SECONDS = '0';
process.env.PERFORMANCE_AGGREGATES_MAINTAIN = 'false';
const { prisma } = await startScript('benchmark-performance-endpoints', { write: false });

try {
  const [
    { getCrePerformanceSummary, getFreeServicePerformanceSummary },
    { getDashboardSummary },
    { getPerformanceBoard },
    { getSnapshot },
    { workshopDayRange, workshopMonthOf },
  ] = await Promise.all([
    import('../../src/controllers/callWorkflowController.js'),
    import('../../src/controllers/recordsController.js'),
    import('../../src/controllers/quotaController.js'),
    import('../../src/services/performanceSnapshotService.js'),
    import('../../src/utils/workshopTime.js'),
  ]);
  const now = new Date();
  const day = workshopDayRange(now);
  const month = workshopMonthOf(now);
  const [ccm, cre, freeServiceCre] = await Promise.all([
    prisma.user.findUnique({ where: { id: 'bu_ccm1' } }),
    prisma.user.findUnique({ where: { id: 'bu_ccm1_cre1' } }),
    prisma.user.findUnique({ where: { id: 'bu_ccm1_fscre' } }),
  ]);
  if (!ccm || !cre || !freeServiceCre) {
    throw new Error('Expected benchmark users bu_ccm1, bu_ccm1_cre1 and bu_ccm1_fscre are missing.');
  }

  const snapshotKeys = [
    { creId: cre.id, ccmId: cre.ccmId, year: month.year, month: month.month, viewer: 'CRE' },
    { creId: freeServiceCre.id, ccmId: freeServiceCre.ccmId, year: month.year, month: month.month, viewer: 'FREE_SERVICE_CRE' },
  ];
  const snapshotRows = await Promise.all(snapshotKeys.map((key) => getSnapshot(key)));
  const refreshAfter = 15 * 60 * 1000;
  for (const [index, row] of snapshotRows.entries()) {
    if (!row || row.status !== 'ok' || !row.computedAt || now.getTime() - row.computedAt.getTime() > refreshAfter) {
      throw new Error(`Missing or stale benchmark snapshot for ${JSON.stringify(snapshotKeys[index])}; refusing a benchmark that would enqueue refresh work.`);
    }
  }

  const requests = [
    {
      name: '/performance/summary (CRE)',
      handler: getCrePerformanceSummary,
      user: cre,
      query: { year: month.year, month: month.month, date: day.dateKey, range: 'day' },
    },
    {
      name: '/performance/free-service (FREE_SERVICE_CRE)',
      handler: getFreeServicePerformanceSummary,
      user: freeServiceCre,
      query: { year: month.year, month: month.month, date: day.dateKey, range: 'day' },
    },
    { name: '/dashboard (CRE)', handler: getDashboardSummary, user: cre, query: {} },
    { name: '/dashboard (FREE_SERVICE_CRE)', handler: getDashboardSummary, user: freeServiceCre, query: {} },
    { name: '/performance/board (CCM)', handler: getPerformanceBoard, user: ccm, query: { date: day.dateKey } },
  ];
  const samples = Object.fromEntries(requests.map(({ name }) => [name, { old: [], new: [] }]));

  async function invoke(request, enabled) {
    const previous = process.env.PERFORMANCE_AGGREGATES_ENABLED;
    process.env.PERFORMANCE_AGGREGATES_ENABLED = String(enabled);
    try {
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      const started = performance.now();
      await request.handler({ method: 'GET', user: request.user, query: request.query }, response);
      const elapsedMs = performance.now() - started;
      if (response.statusCode !== 200) throw new Error(`${request.name} returned ${response.statusCode}`);
      return { elapsedMs, body: response.body };
    } finally {
      if (previous === undefined) delete process.env.PERFORMANCE_AGGREGATES_ENABLED;
      else process.env.PERFORMANCE_AGGREGATES_ENABLED = previous;
    }
  }

  for (const request of requests) {
    await invoke(request, false);
    await invoke(request, true);
    for (let index = 0; index < iterations; index += 1) {
      const order = index % 2 === 0 ? [false, true] : [true, false];
      for (const enabled of order) {
        const result = await invoke(request, enabled);
        samples[request.name][enabled ? 'new' : 'old'].push(result.elapsedMs);
      }
    }
  }

  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  };
  const summarize = (values) => ({
    samples: values.length,
    p50Ms: Number(percentile(values, 50).toFixed(2)),
    p95Ms: Number(percentile(values, 95).toFixed(2)),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
  });
  const results = Object.fromEntries(Object.entries(samples).map(([name, byVersion]) => [
    name,
    { old: summarize(byVersion.old), new: summarize(byVersion.new) },
  ]));
  console.log(JSON.stringify({
    database: 'lakshmi_hyundai_crm_bench',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mode: 'read-only controller benchmark; excludes HTTP/network latency',
    iterations,
    snapshotKeys,
    results,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
