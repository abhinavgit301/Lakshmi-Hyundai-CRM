import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildDuplicateKey, normalizeVin } from '../utils/roleAccess.js';
import { evaluateRepairOrderRow } from '../utils/businessRules.js';
import { parseRepairOrderCsv, parseRepairOrderDate } from '../utils/repairOrderCsv.js';
import { normalizeSaleDate } from '../utils/serviceCalendar.js';
import { prisma } from '../config/prisma.js';
import { allocateUnassignedMasterCallListEntries, lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { importSnapshot, recordImportChange } from '../utils/importChangeLog.js';
import { ImportRollbackConflict, rollbackImportBatch } from '../services/importRollbackService.js';
import { ImportRecoveryConflict, recoverAbandonedImport } from '../services/importRecoveryService.js';
import { acquireImportProcessingLock, assertImportBatchProcessing } from '../utils/importProcessingLock.js';
import {
  collectImportBatchStats,
  collectImportBatchStatsForIds,
  legacyImportHistoryProgress,
  importRowMutationEvidenceIsComplete,
  importRollbackCompleteness,
} from '../utils/importBatchStats.js';

function roleName(role) {
  return String(role || '').toUpperCase();
}

function parseOptionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : NaN;
}

function parseOptionalDate(value) {
  return parseRepairOrderDate(value);
}

function parseOptionalYear(value) {
  if (value == null || String(value).trim() === '') return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1950 && year <= new Date().getFullYear() + 1 ? year : NaN;
}

function parseOptionalMileage(value) {
  if (value == null || String(value).trim() === '') return null;
  const mileage = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(mileage) && mileage >= 0 ? mileage : NaN;
}

function toRowError(row, rowNumber, code, message) {
  return {
    rowNumber,
    vin: normalizeVin(row.vin || '') || null,
    errorCode: code,
    errorMessage: message,
  };
}

function sanitizeImportBatch(batch) {
  if (!batch) return batch;
  const { idempotencyKey: _idempotencyKey, contentHash: _contentHash, ...safeBatch } = batch;
  return safeBatch;
}

async function recordRowError(transaction, batchId, rowError) {
  await transaction.importRowError.create({ data: { importBatchId: batchId, ...rowError } });
}

async function completeImportRow(transaction, batchId, rowNumber, rowProgressId, outcome) {
  const changes = await transaction.importChangeLog.findMany({
    where: { importBatchId: batchId, rowProgressId },
  });
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

async function getTargetCcm(rowCcmId, user, defaultCcmId) {
  const targetCcmId = roleName(user.role) === 'CCM'
    ? user.ccmId
    : String(rowCcmId || defaultCcmId || '').trim();
  if (!targetCcmId) return null;
  const ccm = await prisma.user.findFirst({
    where: { role: 'CCM', ccmId: targetCcmId, status: 'active' },
    select: { ccmId: true },
  });
  return ccm?.ccmId || null;
}

export async function importRepairOrders(req, res) {
  const fileName = path.basename(String(req.body?.fileName || 'repair-orders.csv')).slice(0, 255);
  const content = req.body?.content ?? req.body?.csvContent;
  if (typeof content !== 'string' || content.length > 1_800_000) {
    return res.status(400).json({ message: 'CSV content is required and must be smaller than 1.8 MB.' });
  }

  const parsed = parseRepairOrderCsv(content);
  if (parsed.error) return res.status(400).json({ message: parsed.error });
  if (parsed.rows.length === 0) return res.status(400).json({ message: 'CSV has no data rows.' });

  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim() || null;
  if (idempotencyKey && (idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey))) {
    return res.status(400).json({ message: 'Idempotency-Key must be 1-128 letters, numbers, dots, underscores, colons, or hyphens.' });
  }
  const contentHash = createHash('sha256').update(JSON.stringify({
    fileName,
    content,
    ccmId: String(req.user.ccmId || req.body?.ccmId || '').trim() || null,
  })).digest('hex');
  if (idempotencyKey) {
    const existingBatch = await prisma.importBatch.findUnique({
      where: { idempotencyKey },
      include: { rowErrors: { orderBy: { rowNumber: 'asc' }, take: 100 } },
    });
    if (existingBatch) {
      if (existingBatch.importedByUserId !== req.user.id || existingBatch.contentHash !== contentHash) {
        return res.status(409).json({ message: 'This idempotency key is already associated with a different import request.' });
      }
      if (existingBatch.status === 'completed') {
        return res.status(200).json({ batch: sanitizeImportBatch(existingBatch), errors: existingBatch.rowErrors });
      }
      return res.status(409).json({ message: 'An import with this request key is already processing or did not complete. Refresh Import History before retrying.' });
    }
  }

  const batchId = randomUUID();
  const releaseProcessingLock = await acquireImportProcessingLock(batchId);
  if (!releaseProcessingLock) {
    return res.status(503).json({ message: 'Could not acquire an import processing lock. Retry the request.' });
  }

  const rowProgressIds = new Map(parsed.rows.map(({ rowNumber }) => [rowNumber, randomUUID()]));
  let batch;
  try {
    batch = await prisma.$transaction(async (transaction) => {
      const createdBatch = await transaction.importBatch.create({
        data: {
          id: batchId,
          fileName,
          importedByUserId: req.user.id,
          idempotencyKey,
          contentHash,
          totalRows: parsed.rows.length,
          processedRows: 0,
          processingStartedAt: new Date(),
          status: 'processing',
          rollbackSupported: false,
          statsComplete: false,
        },
      });
      await transaction.importRowProgress.createMany({
        data: parsed.rows.map(({ rowNumber }) => ({
          id: rowProgressIds.get(rowNumber),
          importBatchId: createdBatch.id,
          rowNumber,
        })),
      });
      return createdBatch;
    });
  } catch (error) {
    await releaseProcessingLock();
    if (error?.code !== 'P2002' || !idempotencyKey) throw error;
    const existingBatch = await prisma.importBatch.findUnique({
      where: { idempotencyKey },
      include: { rowErrors: { orderBy: { rowNumber: 'asc' }, take: 100 } },
    });
    if (!existingBatch || existingBatch.importedByUserId !== req.user.id || existingBatch.contentHash !== contentHash) {
      return res.status(409).json({ message: 'This import request is already being processed with the same request key.' });
    }
    if (existingBatch.status === 'completed') {
      return res.status(200).json({ batch: sanitizeImportBatch(existingBatch), errors: existingBatch.rowErrors });
    }
    return res.status(409).json({ message: 'An import with this request key is already processing or did not complete. Refresh Import History before retrying.' });
  }
  const errors = [];
  const existingKeys = new Set();
  const importedCcmIds = new Set();
  let changeSequence = 0;
  const logChange = (transaction, rowProgressId, change, evidenceScope = 'row') => recordImportChange(transaction, {
    importBatchId: batch.id,
    rowProgressId,
    evidenceScope,
    sequence: ++changeSequence,
    ...change,
  });
  const createTrackedRecord = async (transaction, rowProgressId, change, create) => {
    const record = await create();
    await logChange(transaction, rowProgressId, {
      ...change,
      entityId: record.id,
      operation: 'CREATE',
      before: {},
      after: record,
    });
    return record;
  };
  const updateTrackedRecord = async (transaction, rowProgressId, change, update) => {
    const updatedRecord = await update();
    const after = Object.fromEntries(Object.keys(change.before).map((field) => [field, updatedRecord[field]]));
    await logChange(transaction, rowProgressId, {
      ...change,
      operation: 'UPDATE',
      after,
    });
    return updatedRecord;
  };
  const updateBatchTrackedRecord = async (transaction, change, update) => {
    const updatedRecord = await update();
    const after = Object.fromEntries(Object.keys(change.before).map((field) => [field, updatedRecord[field]]));
    await logChange(transaction, null, {
      ...change,
      operation: 'UPDATE',
      after,
    }, 'batch');
    return updatedRecord;
  };

  try {
    const repairOrderNumbers = [...new Set(parsed.rows.map(({ row }) => String(row.roNumber || '').trim()).filter(Boolean))];
    const existingVisits = await prisma.workshopVisit.findMany({
      where: { repairOrderNo: { in: repairOrderNumbers } },
      include: { vehicle: { select: { vin: true } } },
    });
    for (const visit of existingVisits) existingKeys.add(buildDuplicateKey(visit.vehicle.vin, visit.repairOrderNo));

    for (const { row, rowNumber } of parsed.rows) {
      const rowProgressId = rowProgressIds.get(rowNumber);
      const vin = normalizeVin(row.vin || '');
      const roNumber = String(row.roNumber || '').trim();
      const customerName = String(row.customerName || '').trim();
      const mobileNumber = String(row.mobileNumber || '').trim();
      const ccmId = await getTargetCcm(row.ccmId, req.user, req.body?.ccmId);
      const laborCost = parseOptionalNumber(row.totalLaborCost);
      const partsCost = parseOptionalNumber(row.totalPartsCost);
      const visitDate = parseOptionalDate(row.visitDate);
      const closingDate = parseOptionalDate(row.closingDate);
      const gpDate = parseOptionalDate(row.gpDate);
      const saleDate = parseOptionalDate(row.saleDate);
      const ucSaleDate = parseOptionalDate(row.ucSaleDate);
      const mileage = parseOptionalMileage(row.mileage);
      const year = parseOptionalYear(row.year);

      let earlyError = null;
      if (!customerName || !mobileNumber) earlyError = toRowError(row, rowNumber, 'MISSING_CUSTOMER_FIELDS', 'Customer name and mobile number are required.');
      else if (Number.isNaN(laborCost) || Number.isNaN(partsCost)) earlyError = toRowError(row, rowNumber, 'INVALID_COST', 'Labor and parts costs must be non-negative numbers.');
      else if (Number.isNaN(visitDate)) earlyError = toRowError(row, rowNumber, 'INVALID_VISIT_DATE', 'Visit date is invalid.');
      else if (Number.isNaN(closingDate) || Number.isNaN(gpDate) || Number.isNaN(saleDate) || Number.isNaN(ucSaleDate)) earlyError = toRowError(row, rowNumber, 'INVALID_DATE', 'A closing, G.P., sale, or UC sale date is invalid.');
      else if (Number.isNaN(mileage)) earlyError = toRowError(row, rowNumber, 'INVALID_MILEAGE', 'Mileage must be a non-negative number.');
      else if (Number.isNaN(year)) earlyError = toRowError(row, rowNumber, 'INVALID_VEHICLE_YEAR', 'Vehicle year is invalid.');
      else if (!ccmId) earlyError = toRowError(row, rowNumber, 'INVALID_CCM', 'An active CCM assignment is required.');

      if (earlyError) {
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          await recordRowError(transaction, batch.id, earlyError);
          await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, 'rejected');
        });
        errors.push({ ...earlyError, status: 'rejected' });
        continue;
      }

      const vehicleOwner = await prisma.vehicle.findUnique({
        where: { vin },
        select: { ccmId: true, customer: { select: { ccmId: true } } },
      });
      const result = evaluateRepairOrderRow({
        ...row,
        vin,
        roNumber,
        ccmId,
        ownerCcmId: vehicleOwner?.ccmId || vehicleOwner?.customer?.ccmId || null,
      }, existingKeys);

      if (result.status !== 'processed') {
        const code = result.status === 'flagged' ? 'VIN_CONFLICT' : result.status === 'skipped' ? 'DUPLICATE_RO' : 'INVALID_ROW';
        const rowError = toRowError(row, rowNumber, code, result.reason);
        errors.push({ ...rowError, status: result.status });
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          if (result.status === 'flagged') {
            await createTrackedRecord(transaction, rowProgressId, {
              entityType: 'VINConflictReview',
              ccmId,
            }, () => transaction.vINConflictReview.create({
              data: {
                vin,
                sourceCcmId: vehicleOwner.ccmId || vehicleOwner.customer?.ccmId,
                targetCcmId: ccmId,
                reason: result.reason,
              },
            }));
          }
          const outcome = result.status === 'flagged' ? 'flagged' : result.status === 'skipped' ? 'skipped' : 'rejected';
          await recordRowError(transaction, batch.id, rowError);
          await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, outcome);
        });
        if (result.status === 'flagged') {
          existingKeys.add(buildDuplicateKey(vin, roNumber));
        }
        continue;
      }

      try {
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          await lockCcmAllocationTeam(transaction, ccmId);
          let vehicle = await transaction.vehicle.findUnique({ where: { vin }, include: { customer: true } });
          const wasExistingVehicle = Boolean(vehicle);
          let customer = vehicle?.customer;

          if (!customer) {
            customer = await transaction.customer.findFirst({
              where: { mobileNumber, ccmId },
              orderBy: { createdAt: 'asc' },
            });
            if (!customer) {
              customer = await createTrackedRecord(transaction, rowProgressId, {
                entityType: 'Customer',
                ccmId,
              }, () => transaction.customer.create({
                data: {
                  customerCode: `CUS-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
                  fullName: customerName,
                  mobileNumber,
                  email: String(row.email || '').trim().toLowerCase() || null,
                  ccmId,
                },
              }));
            }
          }

          if (!vehicle) {
            vehicle = await createTrackedRecord(transaction, rowProgressId, {
              entityType: 'Vehicle',
              ccmId,
            }, () => transaction.vehicle.create({
              data: {
                vin,
                registrationNumber: String(row.registrationNumber || '').trim().toUpperCase() || null,
                make: String(row.make || '').trim() || null,
                model: String(row.model || '').trim() || null,
                variant: String(row.variant || '').trim() || null,
                year: year || (saleDate ? saleDate.getFullYear() : null),
                saleDate: normalizeSaleDate(saleDate),
                customerId: customer.id,
                ccmId,
              },
            }));
          } else if (!vehicle.saleDate && normalizeSaleDate(saleDate)) {
            const nextSaleDate = normalizeSaleDate(saleDate);
            vehicle = await updateTrackedRecord(transaction, rowProgressId, {
              entityType: 'Vehicle',
              entityId: vehicle.id,
              ccmId,
              before: { saleDate: vehicle.saleDate, updatedAt: vehicle.updatedAt },
              after: { saleDate: nextSaleDate },
            }, () => transaction.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: nextSaleDate } }));
          }

          await createTrackedRecord(transaction, rowProgressId, {
            entityType: 'WorkshopVisit',
            ccmId,
          }, () => transaction.workshopVisit.create({
            data: {
              repairOrderNo: roNumber,
              customerId: customer.id,
              vehicleId: vehicle.id,
              ccmId,
              totalLaborCost: laborCost,
              totalPartsCost: partsCost,
              totalAmount: laborCost == null && partsCost == null ? null : (laborCost || 0) + (partsCost || 0),
              visitDate,
              closingDate,
              gpDate,
              importedDetails: row,
            },
          }));

          const callListEntry = await transaction.masterCallList.findFirst({ where: { vin, ccmId } });
          if (callListEntry) {
            const before = {
              customerName: callListEntry.customerName,
              mobileNumber: callListEntry.mobileNumber,
              registrationNumber: callListEntry.registrationNumber,
            };
            const after = {
              customerName,
              mobileNumber,
              registrationNumber: vehicle.registrationNumber,
            };
            const callListEntryChanged = JSON.stringify(importSnapshot(before)) !== JSON.stringify(importSnapshot(after));
            if (callListEntryChanged) {
              await updateTrackedRecord(transaction, rowProgressId, {
                entityType: 'MasterCallList',
                entityId: callListEntry.id,
                ccmId,
                before: { ...before, updatedAt: callListEntry.updatedAt },
                after,
              }, () => transaction.masterCallList.update({
                where: { id: callListEntry.id },
                data: after,
              }));
            }
          } else {
            await createTrackedRecord(transaction, rowProgressId, {
              entityType: 'MasterCallList',
              ccmId,
            }, () => transaction.masterCallList.create({
              data: {
                customerName,
                mobileNumber,
                vin,
                registrationNumber: vehicle.registrationNumber,
                ccmId,
              },
            }));
          }
          await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, wasExistingVehicle ? 'appended' : 'created');
          return wasExistingVehicle ? 'appended' : 'created';
        });
        importedCcmIds.add(ccmId);
        existingKeys.add(buildDuplicateKey(vin, roNumber));
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
        const rowError = toRowError(row, rowNumber, 'UNIQUE_CONFLICT', 'Repair order, VIN, or registration number already exists.');
        errors.push({ ...rowError, status: 'rejected' });
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          await recordRowError(transaction, batch.id, rowError);
          await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, 'rejected');
        });
      }
    }

    const updatedBatch = await prisma.$transaction(async (transaction) => {
      await assertImportBatchProcessing(transaction, batch.id);
      let allocationChangeCount = 0;
      for (const ccmId of [...importedCcmIds].sort()) {
        await allocateUnassignedMasterCallListEntries(transaction, ccmId, req.user.id, {
          spreadAcrossTeam: true,
          onMutation: async (change, update) => {
            await updateBatchTrackedRecord(transaction, change, update);
            allocationChangeCount += 1;
          },
        });
      }
      await transaction.importBatch.update({
        where: { id: batch.id },
        data: {
          allocationEvidenceState: 'complete',
          allocationChangeCount,
        },
      });
      const stats = await collectImportBatchStats(transaction, batch.id);
      const rollbackSupported = await importRollbackCompleteness(transaction, batch.id, batch.totalRows);
      if (stats.processedRows !== batch.totalRows) {
        throw new Error('Import row processing did not reach a complete state.');
      }
      const completedBatch = await transaction.importBatch.update({
        where: { id: batch.id },
        data: {
          ...stats,
          status: 'completed',
          rollbackSupported,
          statsComplete: stats.processedRows === batch.totalRows,
          affectedCountsComplete: rollbackSupported,
          recoveryBlockedReason: rollbackSupported ? null : 'Change-log or row-progress completeness could not be verified.',
        },
      });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          entityType: 'ImportBatch',
          entityId: batch.id,
          action: 'REPAIR_ORDER_IMPORT',
          details: JSON.stringify(stats),
        },
      });
      return completedBatch;
    });
    return res.status(201).json({ batch: sanitizeImportBatch(updatedBatch), errors });
  } catch (error) {
    await prisma.$transaction(async (transaction) => {
      const current = await transaction.importBatch.findUnique({
        where: { id: batch.id },
        select: { status: true },
      });
      if (current?.status !== 'processing') return;
      const stats = await collectImportBatchStats(transaction, batch.id);
      await transaction.importBatch.updateMany({
        where: { id: batch.id, status: 'processing' },
        data: {
          ...stats,
          status: 'failed',
          rollbackSupported: false,
          statsComplete: stats.processedRows === batch.totalRows,
          affectedCountsComplete: false,
        },
      });
    });
    throw error;
  } finally {
    await releaseProcessingLock();
  }
}

export async function getImportHistory(req, res) {
  const where = roleName(req.user.role) === 'CCM'
    ? { importedByUserId: req.user.id }
    : {};
  const imports = await prisma.importBatch.findMany({
    where,
    select: {
      id: true,
      fileName: true,
      totalRows: true,
      createdRows: true,
      appendedRows: true,
      skippedRows: true,
      rejectedRows: true,
      flaggedRows: true,
      affectedCustomers: true,
      affectedVehicles: true,
      affectedRepairOrders: true,
      affectedCallListEntries: true,
      affectedAllocations: true,
      status: true,
      rollbackSupported: true,
      statsComplete: true,
      affectedCountsComplete: true,
      processingStartedAt: true,
      processedRows: true,
      recoveryBlockedReason: true,
      rolledBackAt: true,
      createdAt: true,
      rowErrors: { orderBy: { rowNumber: 'asc' }, take: 100 },
      _count: { select: { changes: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const statsByBatch = await collectImportBatchStatsForIds(prisma, imports.map(({ id }) => id));
  return res.json({
    imports: imports.map((batch) => {
      if (!batch.processingStartedAt) {
        return {
          ...batch,
          ...legacyImportHistoryProgress(batch),
          rollbackSupported: false,
          affectedCountsComplete: false,
        };
      }
      return {
        ...batch,
        ...statsByBatch.get(batch.id),
        rowOutcomesProvenance: 'durable-row-progress',
      };
    }),
  });
}

export async function recoverImport(req, res) {
  const importBatchId = String(req.params.id || '').trim();
  if (!importBatchId || importBatchId.length > 128) {
    return res.status(400).json({ message: 'A valid import ID is required.' });
  }
  try {
    const result = await recoverAbandonedImport(importBatchId, req.user.id);
    if (result.status === 'recovery_blocked') {
      return res.status(409).json({ status: result.status, message: result.reason });
    }
    return res.json({ status: result.status, message: 'Import is recoverable and may now be rolled back by an Admin.' });
  } catch (error) {
    if (error instanceof ImportRecoveryConflict) {
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          entityType: 'ImportBatch',
          entityId: importBatchId,
          action: 'REPAIR_ORDER_IMPORT_RECOVERY_ATTEMPT_BLOCKED',
          details: JSON.stringify({ reason: error.message }),
        },
      });
      return res.status(error.message === 'Import not found.' ? 404 : 409).json({ message: error.message });
    }
    throw error;
  }
}

export async function deleteImport(req, res) {
  const importBatchId = String(req.params.id || '').trim();
  if (!importBatchId || importBatchId.length > 128) {
    return res.status(400).json({ message: 'A valid import ID is required.' });
  }

  try {
    const result = await rollbackImportBatch(importBatchId, req.user.id);
    return res.json({
      status: result.batch.status,
      batch: sanitizeImportBatch(result.batch),
      reversedChanges: result.reversedChanges,
    });
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'ImportBatch',
        entityId: importBatchId,
        action: error instanceof ImportRollbackConflict
          ? 'REPAIR_ORDER_IMPORT_ROLLBACK_BLOCKED'
          : 'REPAIR_ORDER_IMPORT_ROLLBACK_FAILED',
        details: JSON.stringify({
          reason: error instanceof ImportRollbackConflict
            ? error.message
            : error?.code === 'P2034'
              ? 'Serialization conflict.'
              : 'Unexpected rollback failure.',
        }),
      },
    });
    if (error instanceof ImportRollbackConflict) {
      return res.status(error.message === 'Import not found.' ? 404 : 409).json({ message: error.message });
    }

    if (error?.code === 'P2034') {
      return res.status(409).json({ message: 'The import changed during rollback. Refresh Import History and try again.' });
    }
    throw error;
  }
}