// Benchmark adapter. The SQL builder now lives in the application (src/utils/masterCallListSql.js) and the two-phase
// loader in recordsController.loadCallListPageTwoPhase; this file only re-exports them for the Phase 1A parity,
// fixture, perf and explain harnesses, so those harnesses exercise the exact production code.
// It runs the SQL over a caller-supplied `pg` client (the guarded read-only benchmark connection).

import { buildMasterCallListPageSql, runMasterCallListPage } from '../../src/utils/masterCallListSql.js';

export { buildMasterCallListPageSql, runMasterCallListPage };

// `app` = { records: recordsController module, masterList, prisma } (masterList/prisma are kept for call-site compatibility).
export async function loadMasterCallListPageTwoPhase({
  app,
  queryable,
  user,
  requestedCcmId = '',
  filters,
  pagination,
  now = new Date(),
  today = now,
  options = {},
}) {
  let result;
  try {
    result = await app.records.loadCallListPageTwoPhase({
      user,
      requestedCcmId,
      filters,
      pagination,
      now,
      today,
      options,
      runPage: (params) => runMasterCallListPage(queryable, params),
    });
  } catch (error) {
    // The app path fails loudly on an incomplete page; the harnesses report it as missing ids instead.
    if (error?.code !== 'MASTER_CALL_LIST_PAGE_INCOMPLETE') throw error;
    return { records: [], total: 0, limit: pagination.limit, offset: pagination.offset, hasMore: false, missingIds: error.missingIds };
  }
  if (result.error) return result;
  return { ...result, missingIds: [] };
}
