import { importRowMutationEvidenceIsComplete } from './importBatchStats.js';

export async function completeImportRow(transaction, batchId, rowNumber, rowProgressId, outcome, changes = []) {
  // The caller supplies change rows returned by writes in this transaction, avoiding a reread.
  if (changes.some((change) => change.importBatchId !== batchId || change.rowProgressId !== rowProgressId)
    || !importRowMutationEvidenceIsComplete(outcome, changes)) {
    throw new Error(`Import row ${rowNumber} does not have complete mutation evidence.`);
  }
  const result = await transaction.importRowProgress.updateMany({
    where: { id: rowProgressId, importBatchId: batchId, rowNumber, status: 'pending' },
    data: {
      status: 'completed',
      outcome,
      mutationState: 'complete',
      loggedChangeCount: changes.length,
    },
  });
  if (result.count !== 1) throw new Error(`Import row ${rowNumber} was already completed or is missing.`);
  await transaction.importBatch.update({
    where: { id: batchId },
    data: { processedRows: { increment: 1 } },
  });
}
