import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildDuplicateKey, normalizeVin } from '../utils/roleAccess.js';
import { buildRepairOrderKey, normalizeRepairOrderNo } from '../utils/repairOrderIdentity.js';
import { evaluateRepairOrderRow, validateRepairOrderImportFields } from '../utils/businessRules.js';
import { parseRepairOrderCsv, parseRepairOrderDate } from '../utils/repairOrderCsv.js';
import { normalizeSaleDate } from '../utils/serviceCalendar.js';
import { prisma } from '../config/prisma.js';
import { allocateUnassignedMasterCallListEntries, lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { findCanonicalMasterCallListEntry } from '../utils/masterCallList.js';
import { findOrCreatePhysicalVehicle } from '../utils/physicalVehicle.js';
import { importSnapshot, recordImportChange } from '../utils/importChangeLog.js';
import { ImportRollbackConflict, rollbackImportBatch } from '../services/importRollbackService.js';
import { ImportRecoveryConflict, recoverAbandonedImport } from '../services/importRecoveryService.js';
import {
  PermanentImportDeletionConflict,
  permanentlyDeleteImportBatch,
  previewPermanentImportDeletion,
} from '../services/permanentImportDeletionService.js';
import {
  cleanupLegacyImport,
  LegacyImportReconciliationConflict,
  previewLegacyImportCleanup,
  previewLegacyImportReconciliation,
} from '../services/legacyImportReconciliationService.js';
import { acquireImportProcessingLock, assertImportBatchProcessing } from '../utils/importProcessingLock.js';
import {
  collectImportBatchStats,
  collectImportBatchStatsForIds,
  legacyImportHistoryProgress,
  importRollbackCompleteness,
} from '../utils/importBatchStats.js';
import { completeImportRow } from '../utils/importRowProgress.js';

const IMPORT_FINALIZATION_TRANSACTION_TIMEOUT_MS = 30_000;
const IMPORT_ROW_TRANSACTION_TIMEOUT_MS = 30_000;
const IMPORT_HISTORY_PAGE_SIZE = 20;

function decodeImportHistoryCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 128
      || typeof cursor.createdAt !== 'string') return undefined;
    const createdAt = new Date(cursor.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt) return undefined;
    return { id: cursor.id, createdAt };
  } catch {
    return undefined;
  }
}

function roleName(role) {
  return String(role || '').toUpperCase();
}

export function importBatchAttribution(user, requestedCcmId) {
  return {
    importedByUserId: user.id,
    ccmId: roleName(user.role) === 'CCM'
      ? String(user.ccmId || '').trim() || null
      : String(requestedCcmId || '').trim() || null,
  };
}

export async function resolveImportTargetCcm(user, requestedCcmIds, database = prisma) {
  const role = roleName(user?.role);
  if (!['ADMIN', 'GM', 'CCM'].includes(role)) {
    return { error: 'You are not permitted to import repair orders.' };
  }

  const requested = [...new Set(requestedCcmIds.map((value) => String(value || '').trim()).filter(Boolean))];
  if (requested.length > 1) return { error: 'Only one target CCM may be selected.' };

  let ccmId;
  if (role === 'CCM') {
    ccmId = String(user?.ccmId || '').trim();
    if (!ccmId) return { error: 'An active CCM assignment is required.' };
    if (requested.length && requested[0] !== ccmId) {
      return { error: 'CCM users may only import into their authenticated CCM.' };
    }
  } else {
    ccmId = requested[0];
    if (!ccmId) return { error: 'Select a target CCM for this import.' };
  }

  const ccm = await database.user.findFirst({
    where: { role: 'CCM', ccmId, status: 'active' },
    select: { ccmId: true },
  });
  return ccm ? { ccmId: ccm.ccmId } : { error: 'The selected CCM assignment is invalid.' };
}

function isSerializationConflict(error) {
  return error?.code === 'P2034'
    || (error?.code === 'P2010' && (
      error.meta?.code === '40001'
      || error.meta?.driverAdapterError?.cause?.originalCode === '40001'
    ));
}

function isRepairOrderIdentityUniqueConflict(error) {
  if (error?.code !== 'P2002') return false;
  const target = error.meta?.target;
  const targetText = [
    ...(Array.isArray(target) ? target : [target]),
    error.meta?.constraint,
    error.meta?.driverAdapterError?.cause?.constraint,
    error.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return targetText.includes('workshop_visits_ccmid_normalizedrepairorderno_key')
    || (targetText.includes('ccmid') && targetText.includes('normalizedrepairorderno'));
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

function importDetailValues(row) {
  const fields = [
    'serialNo', 'roNumber', 'visitDate', 'closingDate', 'gpDate', 'workType', 'serviceStatus',
    'serviceAdvisor', 'vin', 'registrationNumber', 'model', 'mileage', 'saleDealer', 'saleDate',
    'ucSaleDealer', 'ucSaleDate', 'customerName', 'address', 'email', 'city', 'pin', 'mobileNumber',
    'office', 'technician', 'specialMessage', 'visitType', 'demands', 'make', 'variant', 'year',
    'totalLaborCost', 'totalPartsCost',
  ];
  return Object.fromEntries([...new Set([...fields, ...Object.keys(row)])].map((key) => {
    const value = row[key];
    const text = value == null ? '' : String(value).trim();
    return [key, text || '-'];
  }));
}

export function assignImportTargetCcm(row, targetCcmId) {
  return { ...row, ccmId: targetCcmId };
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

export async function importRepairOrders(req, res) {
  const fileName = path.basename(String(req.body?.fileName || 'repair-orders.csv')).slice(0, 255);
  const content = req.body?.content ?? req.body?.csvContent;
  const requestedCcmIds = [req.body?.ccmId, req.query?.ccmId, req.params?.ccmId];
  const target = await resolveImportTargetCcm(req.user, requestedCcmIds);
  if (target.error) return res.status(403).json({ message: target.error });
  const importedByUserId = req.user.id;
  const batchCcmId = target.ccmId;
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
    ccmId: batchCcmId,
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
          importType: 'repair_order',
          importedByUserId,
          ccmId: batchCcmId,
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
  const existingKeys = new Map();
  const importedCcmIds = new Set();
  let changeSequence = 0;
  const logChange = async (transaction, rowProgressId, change, evidenceScope = 'row', rowEvidence = null) => {
    const recordedChange = await recordImportChange(transaction, {
      importBatchId: batch.id,
      rowProgressId,
      evidenceScope,
      sequence: ++changeSequence,
      ...change,
    });
    if (evidenceScope === 'row') rowEvidence?.push(recordedChange);
    return recordedChange;
  };
  const createTrackedRecord = async (transaction, rowProgressId, change, create, rowEvidence = null) => {
    const record = await create();
    await logChange(transaction, rowProgressId, {
      ...change,
      entityId: record.id,
      operation: 'CREATE',
      before: {},
      after: record,
    }, 'row', rowEvidence);
    return record;
  };
  const updateTrackedRecord = async (transaction, rowProgressId, change, update, rowEvidence = null) => {
    const updatedRecord = await update();
    const after = Object.fromEntries(Object.keys(change.before).map((field) => [field, updatedRecord[field]]));
    await logChange(transaction, rowProgressId, {
      ...change,
      operation: 'UPDATE',
      after,
    }, 'row', rowEvidence);
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
    const preparedRows = parsed.rows.map(({ row, rowNumber }) => {
      const vin = normalizeVin(row.vin || '');
      const roNumber = String(row.roNumber || '').trim();
      const registrationValue = String(row.registrationNumber || '').trim().toUpperCase();
      const registrationNumber = registrationValue && registrationValue !== '-' ? registrationValue : null;
      const customerName = String(row.customerName || '').trim() || '-';
      const mobileNumber = String(row.mobileNumber || '').trim() || '-';
      const ownedRow = assignImportTargetCcm(row, batchCcmId);
      const parsedLaborCost = parseOptionalNumber(row.totalLaborCost);
      const parsedPartsCost = parseOptionalNumber(row.totalPartsCost);
      const parsedVisitDate = parseOptionalDate(row.visitDate);
      const parsedClosingDate = parseOptionalDate(row.closingDate);
      const parsedGpDate = parseOptionalDate(row.gpDate);
      const parsedSaleDate = parseOptionalDate(row.saleDate);
      const parsedYear = parseOptionalYear(row.year);
      return {
        row,
        rowNumber,
        rowProgressId: rowProgressIds.get(rowNumber),
        vin,
        roNumber,
        normalizedRepairOrderNo: normalizeRepairOrderNo(roNumber),
        repairOrderKey: buildRepairOrderKey(batchCcmId, roNumber),
        registrationNumber,
        customerName,
        mobileNumber,
        ownedRow,
        laborCost: Number.isNaN(parsedLaborCost) ? null : parsedLaborCost,
        partsCost: Number.isNaN(parsedPartsCost) ? null : parsedPartsCost,
        visitDate: Number.isNaN(parsedVisitDate) ? null : parsedVisitDate,
        closingDate: Number.isNaN(parsedClosingDate) ? null : parsedClosingDate,
        gpDate: Number.isNaN(parsedGpDate) ? null : parsedGpDate,
        saleDate: Number.isNaN(parsedSaleDate) ? null : parsedSaleDate,
        year: Number.isNaN(parsedYear) ? null : parsedYear,
        importedDetails: importDetailValues(ownedRow),
      };
    });
    const repairOrderNumbers = [...new Set(preparedRows
      .map(({ normalizedRepairOrderNo }) => normalizedRepairOrderNo)
      .filter(Boolean))];
    const existingVisits = await prisma.workshopVisit.findMany({
      where: { ccmId: batchCcmId, normalizedRepairOrderNo: { in: repairOrderNumbers } },
      include: { physicalVehicle: { select: { vin: true } } },
    });
    for (const visit of existingVisits) {
      existingKeys.set(
        buildRepairOrderKey(visit.ccmId, visit.normalizedRepairOrderNo),
        normalizeVin(visit.physicalVehicle.vin),
      );
    }

    for (const preparedRow of preparedRows) {
      const {
        row,
        rowNumber,
        rowProgressId,
        vin,
        roNumber,
        normalizedRepairOrderNo,
        repairOrderKey,
        registrationNumber,
        customerName,
        mobileNumber,
        ownedRow,
        laborCost,
        partsCost,
        visitDate,
        closingDate,
        gpDate,
        saleDate,
        year,
        importedDetails,
      } = preparedRow;
      const ccmId = batchCcmId;

      let earlyError = null;
      const missingImportField = validateRepairOrderImportFields(row);
      if (missingImportField) {
        earlyError = toRowError(
          row,
          rowNumber,
          missingImportField.code,
          `${missingImportField.field} is required.`,
        );
      } else if (!ccmId) earlyError = toRowError(row, rowNumber, 'INVALID_CCM', 'An active CCM assignment is required.');

      if (earlyError) {
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          await recordRowError(transaction, batch.id, earlyError);
          await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, 'rejected');
        });
        errors.push({ ...earlyError, status: 'rejected' });
        continue;
      }

      const ownerCcmId = ccmId;
      const result = evaluateRepairOrderRow({
        ...ownedRow,
        vin,
        roNumber,
        ccmId,
        ownerCcmId: ccmId,
      }, existingKeys);
      if (result.status === 'skipped' && registrationNumber) {
        const rowChanges = [];
        try {
          await prisma.$transaction(async (transaction) => {
            await assertImportBatchProcessing(transaction, batch.id);
            await lockCcmAllocationTeam(transaction, ccmId);
            const existingVisit = await transaction.workshopVisit.findFirst({
              where: { ccmId, normalizedRepairOrderNo },
              include: { physicalVehicle: { select: { id: true, vin: true } } },
            });
            if (existingVisit && normalizeVin(existingVisit.physicalVehicle.vin) === vin) {
              const physicalVehicle = existingVisit.physicalVehicle;
              const vehicle = await transaction.vehicle.findUnique({
                where: { physicalVehicleId_ccmId: { physicalVehicleId: physicalVehicle.id, ccmId } },
              });
              if (vehicle) {
                const registrationOwner = await transaction.vehicle.findFirst({
                  where: {
                    registrationNumber: { equals: registrationNumber, mode: 'insensitive' },
                    ccmId,
                    physicalVehicleId: { not: physicalVehicle.id },
                  },
                  select: { id: true },
                });
                if (registrationOwner) {
                  throw Object.assign(new Error('Registration number is already assigned to another vehicle.'), { code: 'REGISTRATION_CONFLICT' });
                }

                let updatedVehicle = vehicle;
                if ((vehicle.registrationNumber || '').trim().toUpperCase() !== registrationNumber) {
                  updatedVehicle = await updateTrackedRecord(transaction, rowProgressId, {
                    entityType: 'Vehicle',
                    entityId: vehicle.id,
                    ccmId,
                    before: { registrationNumber: vehicle.registrationNumber, updatedAt: vehicle.updatedAt },
                    after: { registrationNumber },
                  }, () => transaction.vehicle.update({
                    where: { id: vehicle.id },
                    data: { registrationNumber },
                  }), rowChanges);
                }
                const callListEntry = await findCanonicalMasterCallListEntry(transaction, vin, ccmId, { lock: false });
                if (callListEntry && callListEntry.registrationNumber !== updatedVehicle.registrationNumber) {
                  await updateTrackedRecord(transaction, rowProgressId, {
                    entityType: 'MasterCallList',
                    entityId: callListEntry.id,
                    ccmId,
                    before: { registrationNumber: callListEntry.registrationNumber, updatedAt: callListEntry.updatedAt },
                    after: { registrationNumber: updatedVehicle.registrationNumber },
                  }, () => transaction.masterCallList.update({
                    where: { id: callListEntry.id },
                    data: { registrationNumber: updatedVehicle.registrationNumber },
                  }), rowChanges);
                }
              }
            }
            const rowError = toRowError(row, rowNumber, 'DUPLICATE_RO', result.reason);
            await recordRowError(transaction, batch.id, rowError);
            await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, 'skipped', rowChanges);
          }, { timeout: IMPORT_ROW_TRANSACTION_TIMEOUT_MS });
          errors.push({ ...toRowError(row, rowNumber, 'DUPLICATE_RO', result.reason), status: 'skipped' });
        } catch (error) {
          if (error?.code !== 'REGISTRATION_CONFLICT' && error?.code !== 'P2002') throw error;
          const rowError = toRowError(row, rowNumber, 'REGISTRATION_CONFLICT', error.message || 'Registration number is already assigned to another vehicle.');
          errors.push({ ...rowError, status: 'rejected' });
          await prisma.$transaction(async (transaction) => {
            await assertImportBatchProcessing(transaction, batch.id);
            await recordRowError(transaction, batch.id, rowError);
            await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, 'rejected');
          });
        }
        continue;
      }
      if (result.status !== 'processed') {
        const code = result.status === 'flagged' ? 'VIN_CONFLICT' : result.status === 'skipped' ? 'DUPLICATE_RO' : 'INVALID_ROW';
        const rowError = toRowError(row, rowNumber, code, result.reason);
        errors.push({ ...rowError, status: result.status });
        const rowChanges = [];
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          if (result.status === 'flagged') {
            await createTrackedRecord(transaction, rowProgressId, {
              entityType: 'VINConflictReview',
              ccmId,
            }, () => transaction.vINConflictReview.create({
              data: {
                vin,
                sourceCcmId: ownerCcmId,
                targetCcmId: ccmId,
                reason: result.reason,
              },
            }), rowChanges);
          }
          const outcome = result.status === 'flagged' ? 'flagged' : result.status === 'skipped' ? 'skipped' : 'rejected';
          await recordRowError(transaction, batch.id, rowError);
          await completeImportRow(transaction, batch.id, rowNumber, rowProgressId, outcome, rowChanges);
        });
        continue;
      }

      const rowChanges = [];
      try {
        await prisma.$transaction(async (transaction) => {
          await assertImportBatchProcessing(transaction, batch.id);
          await lockCcmAllocationTeam(transaction, ccmId);
          const physicalVehicle = await findOrCreatePhysicalVehicle(transaction, vin);
          const registrationOwner = registrationNumber
            ? await transaction.vehicle.findFirst({
              where: {
                registrationNumber: { equals: registrationNumber, mode: 'insensitive' },
                ccmId,
                physicalVehicleId: { not: physicalVehicle.id },
              },
              select: { id: true },
            })
            : null;
          if (registrationOwner) {
            throw Object.assign(new Error('Registration number is already assigned to another vehicle.'), { code: 'REGISTRATION_CONFLICT' });
          }
          let vehicle = await transaction.vehicle.findUnique({
            where: { physicalVehicleId_ccmId: { physicalVehicleId: physicalVehicle.id, ccmId } },
            include: { customer: true },
          });
          const wasExistingVehicle = Boolean(vehicle);
          let customer = vehicle?.customer;

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
            }), rowChanges);
          }

          if (!vehicle) {
            vehicle = await createTrackedRecord(transaction, rowProgressId, {
              entityType: 'Vehicle',
              ccmId,
            }, () => transaction.vehicle.create({
              data: {
                vin,
                physicalVehicleId: physicalVehicle.id,
                registrationNumber,
                make: String(row.make || '').trim() || '-',
                model: String(row.model || '').trim() || '-',
                variant: String(row.variant || '').trim() || '-',
                year: year || (saleDate ? saleDate.getFullYear() : null),
                saleDate: normalizeSaleDate(saleDate),
                customerId: customer.id,
                ccmId,
              },
            }), rowChanges);
          } else if (!vehicle.saleDate && normalizeSaleDate(saleDate)) {
            const nextSaleDate = normalizeSaleDate(saleDate);
            vehicle = await updateTrackedRecord(transaction, rowProgressId, {
              entityType: 'Vehicle',
              entityId: vehicle.id,
              ccmId,
              before: { saleDate: vehicle.saleDate, updatedAt: vehicle.updatedAt },
              after: { saleDate: nextSaleDate },
            }, () => transaction.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: nextSaleDate } }), rowChanges);
          }

          await createTrackedRecord(transaction, rowProgressId, {
            entityType: 'WorkshopVisit',
            ccmId,
          }, () => transaction.workshopVisit.create({
            data: {
              repairOrderNo: roNumber,
              normalizedRepairOrderNo,
              customerId: customer.id,
              vehicleId: vehicle.id,
              physicalVehicleId: physicalVehicle.id,
              ccmId,
              totalLaborCost: laborCost,
              totalPartsCost: partsCost,
              totalAmount: laborCost == null && partsCost == null ? null : (laborCost || 0) + (partsCost || 0),
              visitDate,
              closingDate,
              gpDate,
              importedDetails,
            },
          }), rowChanges);

          if (registrationNumber
            && (vehicle.registrationNumber || '').trim().toUpperCase() !== registrationNumber) {
            vehicle = await updateTrackedRecord(transaction, rowProgressId, {
              entityType: 'Vehicle',
              entityId: vehicle.id,
              ccmId,
              before: { registrationNumber: vehicle.registrationNumber, updatedAt: vehicle.updatedAt },
              after: { registrationNumber },
            }, () => transaction.vehicle.update({
              where: { id: vehicle.id },
              data: { registrationNumber },
              include: { customer: true },
            }), rowChanges);
          }

          const callListEntry = await findCanonicalMasterCallListEntry(transaction, vin, ccmId, { lock: false });
          if (callListEntry) {
            const before = {
              customerName: callListEntry.customerName,
              mobileNumber: callListEntry.mobileNumber,
              registrationNumber: callListEntry.registrationNumber,
              vehicleId: callListEntry.vehicleId,
            };
            const after = {
              customerName: String(row.customerName || '').trim() ? customerName : callListEntry.customerName,
              mobileNumber: String(row.mobileNumber || '').trim() ? mobileNumber : callListEntry.mobileNumber,
              registrationNumber: vehicle.registrationNumber || callListEntry.registrationNumber,
              vehicleId: vehicle.id,
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
              }), rowChanges);
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
                vehicleId: vehicle.id,
                registrationNumber: vehicle.registrationNumber,
                ccmId,
              },
            }), rowChanges);
          }
          await completeImportRow(
            transaction,
            batch.id,
            rowNumber,
            rowProgressId,
            wasExistingVehicle ? 'appended' : 'created',
            rowChanges,
          );
          return wasExistingVehicle ? 'appended' : 'created';
        }, { timeout: IMPORT_ROW_TRANSACTION_TIMEOUT_MS });
        importedCcmIds.add(ccmId);
        existingKeys.set(repairOrderKey, vin);
      } catch (error) {
        if (isRepairOrderIdentityUniqueConflict(error)) {
          // The failed transaction has rolled back before this lookup runs.
          const existingVisit = await prisma.workshopVisit.findFirst({
            where: {
              ccmId,
              normalizedRepairOrderNo,
            },
            select: { physicalVehicle: { select: { vin: true } } },
          });
          if (existingVisit) {
            const samePhysicalVehicle = normalizeVin(existingVisit.physicalVehicle.vin) === vin;
            const status = samePhysicalVehicle ? 'skipped' : 'rejected';
            const rowError = toRowError(
              row,
              rowNumber,
              samePhysicalVehicle ? 'DUPLICATE_RO' : 'UNIQUE_CONFLICT',
              samePhysicalVehicle
                ? 'Duplicate repair order number.'
                : 'Repair order number is already assigned to a different VIN.',
            );
            errors.push({ ...rowError, status });
            await prisma.$transaction(async (transaction) => {
              await assertImportBatchProcessing(transaction, batch.id);
              await recordRowError(transaction, batch.id, rowError);
              await completeImportRow(
                transaction,
                batch.id,
                rowNumber,
                rowProgressId,
                samePhysicalVehicle ? 'skipped' : 'rejected',
              );
            });
            if (samePhysicalVehicle) existingKeys.set(repairOrderKey, vin);
            continue;
          }
        }
        if (error?.code !== 'P2002'
          && error?.code !== 'IDENTITY_CONFLICT'
          && error?.code !== 'REGISTRATION_CONFLICT') throw error;
        const rowError = toRowError(
          row,
          rowNumber,
          error?.code === 'REGISTRATION_CONFLICT' ? 'REGISTRATION_CONFLICT' : error?.code === 'IDENTITY_CONFLICT' ? 'IDENTITY_CONFLICT' : 'UNIQUE_CONFLICT',
          error?.message || 'Repair order, VIN, or registration number already exists.',
        );
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
    }, { timeout: IMPORT_FINALIZATION_TRANSACTION_TIMEOUT_MS });
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
  const role = roleName(req.user.role);
  const requestedCcmId = role === 'ADMIN' ? String(req.query?.ccmId || '').trim() : '';
  if (requestedCcmId.length > 255) {
    return res.status(400).json({ message: 'ccmId must be 255 characters or fewer.' });
  }
  const cursor = decodeImportHistoryCursor(req.query?.cursor);
  if (cursor === undefined) {
    return res.status(400).json({ message: 'Import history cursor is invalid.' });
  }
  const where = {
    ...(role === 'CCM' ? { importedByUserId: req.user.id } : {}),
    ...(requestedCcmId ? { ccmId: requestedCcmId } : {}),
    ...(cursor ? {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    } : {}),
  };
  const imports = await prisma.importBatch.findMany({
    where,
    select: {
      id: true,
      fileName: true,
      importedByUserId: true,
      ccmId: true,
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
      affectedMonthlyEntries: true,
      importType: true,
      status: true,
      rollbackSupported: true,
      statsComplete: true,
      affectedCountsComplete: true,
      processingStartedAt: true,
      processedRows: true,
      recoveryBlockedReason: true,
      rolledBackAt: true,
      rollbackError: true,
      createdAt: true,
      rowErrors: { orderBy: { rowNumber: 'asc' }, take: 100 },
      _count: { select: { changes: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: IMPORT_HISTORY_PAGE_SIZE + 1,
  });
  const hasMore = imports.length > IMPORT_HISTORY_PAGE_SIZE;
  const page = imports.slice(0, IMPORT_HISTORY_PAGE_SIZE);
  const lastBatch = page.at(-1);
  const nextCursor = hasMore && lastBatch
    ? Buffer.from(JSON.stringify({ id: lastBatch.id, createdAt: lastBatch.createdAt.toISOString() })).toString('base64url')
    : null;
  const importerIds = [...new Set(page.map(({ importedByUserId }) => importedByUserId).filter(Boolean))];
  const importers = importerIds.length
    ? await prisma.user.findMany({
      where: { id: { in: importerIds } },
      select: { id: true, name: true, role: true },
    })
    : [];
  const importerById = new Map(importers.map((importer) => [importer.id, importer]));
  const statsByBatch = await collectImportBatchStatsForIds(prisma, page.map(({ id }) => id));
  const invalidatedChanges = page.length
    ? await prisma.importChangeLog.findMany({
      where: { importBatchId: { in: page.map(({ id }) => id) }, rollbackStatus: 'permanently_deleted' },
      select: { importBatchId: true, rollbackError: true, rowProgress: { select: { rowNumber: true } } },
    })
    : [];
  const invalidationByBatch = new Map();
  for (const change of invalidatedChanges) {
    const state = invalidationByBatch.get(change.importBatchId) || { changes: 0, rows: new Set(), causes: new Set() };
    state.changes += 1;
    if (change.rowProgress?.rowNumber != null) state.rows.add(change.rowProgress.rowNumber);
    const cause = change.rollbackError?.match(/permanent deletion of import ([^.]+)/i)?.[1];
    if (cause) state.causes.add(cause);
    invalidationByBatch.set(change.importBatchId, state);
  }
  return res.json({
    imports: page.map((batch) => {
      const invalidation = invalidationByBatch.get(batch.id);
      const permanentDeletion = invalidation && batch.status !== 'permanently_deleted'
        ? {
          invalidatedChanges: invalidation.changes,
          invalidatedRows: [...invalidation.rows].sort((a, b) => a - b),
          causedByImportIds: [...invalidation.causes].sort(),
        }
        : null;
      const importedBy = batch.importedByUserId
        ? importerById.get(batch.importedByUserId) || { id: batch.importedByUserId, name: null, role: null }
        : null;
      if (!batch.processingStartedAt) {
        return {
          ...batch,
          importedBy,
          ...legacyImportHistoryProgress(batch),
          rollbackSupported: false,
          affectedCountsComplete: false,
          permanentDeletion,
        };
      }
      return {
        ...batch,
        importedBy,
        ...statsByBatch.get(batch.id),
        rowOutcomesProvenance: 'durable-row-progress',
        permanentDeletion,
      };
    }),
    hasMore,
    nextCursor,
  });
}

export async function previewPermanentDeletion(req, res) {
  const importBatchId = String(req.params.id || '').trim();
  if (!importBatchId || importBatchId.length > 128) {
    return res.status(400).json({ message: 'A valid import ID is required.' });
  }
  try {
    return res.json(await previewPermanentImportDeletion(importBatchId));
  } catch (error) {
    if (error instanceof PermanentImportDeletionConflict) {
      return res.status(error.message === 'Import not found.' ? 404 : 409).json({
        message: error.message,
        blockers: error.blockers || [],
      });
    }
    throw error;
  }
}

export async function permanentlyDeleteImport(req, res) {
  const importBatchId = String(req.params.id || '').trim();
  if (!importBatchId || importBatchId.length > 128) {
    return res.status(400).json({ message: 'A valid import ID is required.' });
  }
  try {
    const result = await permanentlyDeleteImportBatch(
      importBatchId,
      req.user.id,
      String(req.body?.confirmationToken || ''),
    );
    return res.json(result);
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'ImportBatch',
        entityId: importBatchId,
        action: error instanceof PermanentImportDeletionConflict
          ? 'REPAIR_ORDER_IMPORT_PERMANENT_DELETION_BLOCKED'
          : 'REPAIR_ORDER_IMPORT_PERMANENT_DELETION_FAILED',
        details: JSON.stringify({
          reason: error instanceof PermanentImportDeletionConflict
            ? error.message
            : isSerializationConflict(error)
              ? 'Serialization conflict.'
              : 'Unexpected permanent-deletion failure.',
          blockers: error instanceof PermanentImportDeletionConflict ? error.blockers || [] : [],
        }),
      },
    });
    if (error instanceof PermanentImportDeletionConflict) {
      return res.status(error.message === 'Import not found.' ? 404 : 409).json({
        message: error.message,
        blockers: error.blockers || [],
      });
    }
    if (isSerializationConflict(error)) {
      return res.status(409).json({ message: 'The import changed during permanent deletion. Refresh the preview and try again.' });
    }
    throw error;
  }
}

export async function getLegacyImportReconciliation(_req, res) {
  return res.json(await previewLegacyImportReconciliation());
}

export async function previewLegacyImportCleanupHandler(req, res) {
  const importBatchId = String(req.params.id || '').trim();
  if (!importBatchId || importBatchId.length > 128) {
    return res.status(400).json({ message: 'A valid import ID is required.' });
  }
  try {
    return res.json(await previewLegacyImportCleanup(importBatchId));
  } catch (error) {
    if (error instanceof LegacyImportReconciliationConflict) {
      return res.status(409).json({ message: error.message, blockers: error.blockers });
    }
    throw error;
  }
}

export async function cleanupLegacyImportHandler(req, res) {
  const importBatchId = String(req.params.id || '').trim();
  if (!importBatchId || importBatchId.length > 128) {
    return res.status(400).json({ message: 'A valid import ID is required.' });
  }
  try {
    return res.json(await cleanupLegacyImport(
      importBatchId,
      req.user.id,
      String(req.body?.confirmationToken || ''),
    ));
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'ImportBatch',
        entityId: importBatchId,
        action: error instanceof LegacyImportReconciliationConflict
          ? 'LEGACY_IMPORT_RECONCILIATION_CLEANUP_BLOCKED'
          : 'LEGACY_IMPORT_RECONCILIATION_CLEANUP_FAILED',
        details: JSON.stringify({
          reason: error instanceof LegacyImportReconciliationConflict
            ? error.message
            : isSerializationConflict(error)
              ? 'Serialization conflict.'
              : 'Unexpected legacy cleanup failure.',
          blockers: error instanceof LegacyImportReconciliationConflict ? error.blockers : [],
        }),
      },
    });
    if (error instanceof LegacyImportReconciliationConflict) {
      return res.status(409).json({ message: error.message, blockers: error.blockers });
    }
    if (isSerializationConflict(error)) {
      return res.status(409).json({ message: 'Legacy import evidence changed during cleanup. Refresh the reconciliation preview and try again.' });
    }
    throw error;
  }
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