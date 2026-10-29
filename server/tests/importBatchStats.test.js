import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectImportBatchStatsForIds,
  importBatchMutationEvidenceIsComplete,
  legacyImportHistoryProgress,
} from '../src/utils/importBatchStats.js';

test('import stats count completed row outcomes and distinct changed entities', async () => {
  const transaction = {
    importRowProgress: {
      groupBy: async ({ by, where }) => {
        const rows = [
          { importBatchId: 'batch-1', status: 'completed', outcome: 'created' },
          { importBatchId: 'batch-1', status: 'completed', outcome: 'appended' },
          { importBatchId: 'batch-1', status: 'pending', outcome: null },
        ];
        return groupRows(rows.filter((row) => row.importBatchId === 'batch-1'
          && (!where.status || row.status === where.status)), by);
      },
    },
    importChangeLog: {
      groupBy: async ({ by }) => groupRows([
        { importBatchId: 'batch-1', entityType: 'Customer', entityId: 'customer-1' },
        { importBatchId: 'batch-1', entityType: 'Customer', entityId: 'customer-1' },
        { importBatchId: 'batch-1', entityType: 'Vehicle', entityId: 'vehicle-1' },
        { importBatchId: 'batch-1', entityType: 'WorkshopVisit', entityId: 'visit-1' },
      ], by).map(({ _count, ...entity }) => entity),
    },
  };
  const stats = await collectImportBatchStatsForIds(transaction, ['batch-1']).then((result) => result.get('batch-1'));

  assert.equal(stats.processedRows, 2);
  assert.equal(stats.createdRows, 1);
  assert.equal(stats.appendedRows, 1);
  assert.equal(stats.affectedCustomers, 1);
  assert.equal(stats.affectedVehicles, 1);
  assert.equal(stats.affectedRepairOrders, 1);
});

test('legacy failed imports expose unknown row progress and incomplete outcome statistics', () => {
  const progress = legacyImportHistoryProgress({
    status: 'failed',
    totalRows: 12,
    processedRows: 0,
  });

  assert.equal(progress.processedRows, null);
  assert.equal(progress.statsComplete, false);
  assert.equal(progress.rowOutcomesProvenance, 'unknown');
});

test('legacy completed imports retain the status-derived total but label stored row counts unverified', () => {
  const progress = legacyImportHistoryProgress({
    status: 'completed',
    totalRows: 12,
  });

  assert.equal(progress.processedRows, 12);
  assert.equal(progress.statsComplete, false);
  assert.equal(progress.rowOutcomesProvenance, 'legacy-stored-unverified');
});

test('row mutation evidence accepts explicit no-mutation outcomes but rejects mutation rows without logs', () => {
  const base = {
    id: 'batch-1',
    totalRows: 1,
    allocationEvidenceState: 'not_started',
    allocationChangeCount: 0,
    rowProgress: [{
      id: 'progress-1',
      importBatchId: 'batch-1',
      rowNumber: 2,
      status: 'completed',
      outcome: 'skipped',
      mutationState: 'complete',
      loggedChangeCount: 0,
    }],
    changes: [],
  };
  assert.equal(importBatchMutationEvidenceIsComplete(base), true);
  assert.equal(importBatchMutationEvidenceIsComplete({
    ...base,
    rowProgress: [{ ...base.rowProgress[0], outcome: 'created' }],
  }), false);
});

test('a change log without a completed row evidence record is not considered transactionally complete', () => {
  const pending = {
    id: 'batch-1',
    totalRows: 1,
    rowProgress: [{
      id: 'progress-1',
      importBatchId: 'batch-1',
      rowNumber: 2,
      status: 'pending',
      outcome: null,
      mutationState: 'pending',
      loggedChangeCount: 0,
    }],
    changes: [{
      importBatchId: 'batch-1',
      rowProgressId: 'progress-1',
      evidenceScope: 'row',
      entityType: 'WorkshopVisit',
      entityId: 'visit-1',
      operation: 'CREATE',
      before: {},
      after: {
        id: 'visit-1',
        repairOrderNo: 'RO-1',
        customerId: 'customer-1',
        vehicleId: 'vehicle-1',
        ccmId: null,
        totalLaborCost: null,
        totalPartsCost: null,
        totalAmount: null,
        visitDate: null,
        closingDate: null,
        gpDate: null,
        importedDetails: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    }],
  };
  assert.equal(importBatchMutationEvidenceIsComplete(pending), false);
});

test('batch allocation evidence is accepted only with matching allocation logs', () => {
  const rowProgress = [{
    id: 'progress-1',
    importBatchId: 'batch-1',
    rowNumber: 2,
    status: 'completed',
    outcome: 'skipped',
    mutationState: 'complete',
    loggedChangeCount: 0,
  }];
  const batchChange = {
    importBatchId: 'batch-1',
    rowProgressId: null,
    evidenceScope: 'batch',
    entityType: 'MasterCallList',
    entityId: 'call-1',
    operation: 'UPDATE',
    before: { ownerUserId: null, updatedAt: '2025-01-01T00:00:00.000Z' },
    after: { ownerUserId: 'cre-1', updatedAt: '2025-01-02T00:00:00.000Z' },
  };
  const complete = {
    id: 'batch-1',
    totalRows: 1,
    rowProgress,
    changes: [batchChange],
    allocationEvidenceState: 'complete',
    allocationChangeCount: 1,
  };

  assert.equal(importBatchMutationEvidenceIsComplete(complete), true);
  assert.equal(importBatchMutationEvidenceIsComplete({
    ...complete,
    allocationChangeCount: 0,
  }), false);
  assert.equal(importBatchMutationEvidenceIsComplete({
    ...complete,
    changes: [{ ...batchChange, before: { ownerUserId: null }, after: { ownerUserId: 'cre-1' } }],
  }), false);
});

function groupRows(rows, by) {
  const groups = new Map();
  for (const row of rows) {
    const key = by.map((field) => row[field] ?? '<null>').join('|');
    if (groups.has(key)) groups.get(key).count += 1;
    else groups.set(key, { row, count: 1 });
  }
  return [...groups.entries()].map(([key, { row, count }]) => ({
    ...Object.fromEntries(by.map((field, index) => [field, key.split('|')[index] === '<null>' ? null : row[field]])),
    _count: { _all: count },
  }));
}
