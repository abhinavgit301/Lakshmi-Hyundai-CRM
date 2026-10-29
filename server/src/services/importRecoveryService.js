import { prisma } from '../config/prisma.js';
import { acquireImportProcessingLock } from '../utils/importProcessingLock.js';
import {
  collectImportBatchStats,
  importBatchMutationEvidenceIsComplete,
} from '../utils/importBatchStats.js';

export class ImportRecoveryConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportRecoveryConflict';
  }
}

export async function recoverAbandonedImport(
  importBatchId,
  adminId,
  database = prisma,
  lockAcquirer = acquireImportProcessingLock,
) {
  const releaseLock = await lockAcquirer(importBatchId);
  if (!releaseLock) {
    throw new ImportRecoveryConflict('This import is still active in another worker. Wait for it to finish before recovery.');
  }

  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "import_batches" WHERE "id" = ${importBatchId} FOR UPDATE`;
      const batch = await transaction.importBatch.findUnique({
        where: { id: importBatchId },
        include: {
          changes: { orderBy: { sequence: 'asc' } },
          rowProgress: {
            select: {
              id: true,
              importBatchId: true,
              rowNumber: true,
              status: true,
              outcome: true,
              mutationState: true,
              loggedChangeCount: true,
            },
          },
        },
      });
      if (!batch) throw new ImportRecoveryConflict('Import not found.');
      if (batch.status === 'recovery_blocked') {
        return { status: batch.status, reason: batch.recoveryBlockedReason, batch };
      }
      if (!['processing', 'failed'].includes(batch.status) || batch.rollbackSupported) {
        throw new ImportRecoveryConflict('Only an unrecovered processing or failed import can be recovered.');
      }

      const completedRows = batch.rowProgress.filter(({ status }) => status === 'completed').length;
      const evidenceComplete = importBatchMutationEvidenceIsComplete(batch);
      if (!evidenceComplete) {
        const reason = `Recovery blocked: durable row outcomes, mutation counts, or change-log snapshots are incomplete or contradictory (${completedRows} of ${batch.totalRows} rows are complete). No business records were changed by recovery.`;
        const blockedBatch = await transaction.importBatch.update({
          where: { id: batch.id },
          data: {
            status: 'recovery_blocked',
            rollbackSupported: false,
            statsComplete: false,
            affectedCountsComplete: false,
            recoveryBlockedReason: reason,
          },
        });
        await transaction.auditLog.create({
          data: {
            userId: adminId,
            entityType: 'ImportBatch',
            entityId: batch.id,
            action: 'REPAIR_ORDER_IMPORT_RECOVERY_BLOCKED',
            details: JSON.stringify({ reason }),
          },
        });
        return { status: blockedBatch.status, reason, batch: blockedBatch };
      }

      const stats = await collectImportBatchStats(transaction, batch.id);
      const recoveredBatch = await transaction.importBatch.update({
        where: { id: batch.id },
        data: {
          ...stats,
          status: 'failed',
          rollbackSupported: true,
          statsComplete: true,
          affectedCountsComplete: true,
          recoveryBlockedReason: null,
        },
      });
      await transaction.auditLog.create({
        data: {
          userId: adminId,
          entityType: 'ImportBatch',
          entityId: batch.id,
          action: 'REPAIR_ORDER_IMPORT_RECOVERED',
          details: JSON.stringify({ processedRows: stats.processedRows, changeCount: batch.changes.length }),
        },
      });
      return { status: recoveredBatch.status, batch: recoveredBatch };
    }, { isolationLevel: 'Serializable' });
  } finally {
    await releaseLock();
  }
}
