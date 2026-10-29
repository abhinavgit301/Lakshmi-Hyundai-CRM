import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildDuplicateKey, normalizeVin } from '../utils/roleAccess.js';
import { evaluateRepairOrderRow } from '../utils/businessRules.js';
import { parseRepairOrderCsv } from '../utils/repairOrderCsv.js';
import { normalizeSaleDate } from '../utils/serviceCalendar.js';
import { prisma } from '../config/prisma.js';
import { allocateUnassignedMasterCallListEntries, lockCcmAllocationTeam } from '../utils/customerAllocation.js';

function roleName(role) {
  return String(role || '').toUpperCase();
}

function parseOptionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : NaN;
}

function parseOptionalDate(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const localDate = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const date = localDate
    ? new Date(Number(localDate[3]), Number(localDate[2]) - 1, Number(localDate[1]))
    : new Date(raw);
  if (localDate && (
    date.getFullYear() !== Number(localDate[3])
    || date.getMonth() !== Number(localDate[2]) - 1
    || date.getDate() !== Number(localDate[1])
  )) return NaN;
  return Number.isNaN(date.getTime()) ? NaN : date;
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

async function recordRowError(batchId, rowError) {
  await prisma.importRowError.create({ data: { importBatchId: batchId, ...rowError } });
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

  const batch = await prisma.importBatch.create({
    data: {
      fileName,
      importedByUserId: req.user.id,
      totalRows: parsed.rows.length,
      status: 'processing',
    },
  });
  const counts = { createdRows: 0, appendedRows: 0, skippedRows: 0, rejectedRows: 0, flaggedRows: 0 };
  const errors = [];
  const existingKeys = new Set();
  const importedCcmIds = new Set();

  try {
    const repairOrderNumbers = [...new Set(parsed.rows.map(({ row }) => String(row.roNumber || '').trim()).filter(Boolean))];
    const existingVisits = await prisma.workshopVisit.findMany({
      where: { repairOrderNo: { in: repairOrderNumbers } },
      include: { vehicle: { select: { vin: true } } },
    });
    for (const visit of existingVisits) existingKeys.add(buildDuplicateKey(visit.vehicle.vin, visit.repairOrderNo));

    for (const { row, rowNumber } of parsed.rows) {
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
        counts.rejectedRows += 1;
        errors.push({ ...earlyError, status: 'rejected' });
        await recordRowError(batch.id, earlyError);
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
        counts[`${result.status === 'flagged' ? 'flagged' : result.status === 'skipped' ? 'skipped' : 'rejected'}Rows`] += 1;
        errors.push({ ...rowError, status: result.status });
        if (result.status === 'flagged') {
          await prisma.vINConflictReview.create({
            data: {
              vin,
              sourceCcmId: vehicleOwner.ccmId || vehicleOwner.customer?.ccmId,
              targetCcmId: ccmId,
              reason: result.reason,
            },
          });
          existingKeys.add(buildDuplicateKey(vin, roNumber));
        }
        await recordRowError(batch.id, rowError);
        continue;
      }

      try {
        const outcome = await prisma.$transaction(async (transaction) => {
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
              customer = await transaction.customer.create({
                data: {
                  customerCode: `CUS-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
                  fullName: customerName,
                  mobileNumber,
                  email: String(row.email || '').trim().toLowerCase() || null,
                  ccmId,
                },
              });
            }
          }

          if (!vehicle) {
            vehicle = await transaction.vehicle.create({
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
            });
          } else if (!vehicle.saleDate && normalizeSaleDate(saleDate)) {
            vehicle = await transaction.vehicle.update({ where: { id: vehicle.id }, data: { saleDate: normalizeSaleDate(saleDate) } });
          }

          await transaction.workshopVisit.create({
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
          });

          const callListEntry = await transaction.masterCallList.findFirst({ where: { vin, ccmId } });
          if (callListEntry) {
            await transaction.masterCallList.update({
              where: { id: callListEntry.id },
              data: { customerName, mobileNumber, registrationNumber: vehicle.registrationNumber },
            });
          } else {
            await transaction.masterCallList.create({
              data: {
                customerName,
                mobileNumber,
                vin,
                registrationNumber: vehicle.registrationNumber,
                ccmId,
              },
            });
          }
          return wasExistingVehicle ? 'appended' : 'created';
        });
        importedCcmIds.add(ccmId);
        counts[outcome === 'created' ? 'createdRows' : 'appendedRows'] += 1;
        existingKeys.add(buildDuplicateKey(vin, roNumber));
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
        const rowError = toRowError(row, rowNumber, 'UNIQUE_CONFLICT', 'Repair order, VIN, or registration number already exists.');
        counts.rejectedRows += 1;
        errors.push({ ...rowError, status: 'rejected' });
        await recordRowError(batch.id, rowError);
      }
    }

    const updatedBatch = await prisma.$transaction(async (transaction) => {
      for (const ccmId of [...importedCcmIds].sort()) {
        await allocateUnassignedMasterCallListEntries(transaction, ccmId, req.user.id, { spreadAcrossTeam: true });
      }
      const completedBatch = await transaction.importBatch.update({
        where: { id: batch.id },
        data: { ...counts, status: 'completed' },
      });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          entityType: 'ImportBatch',
          entityId: batch.id,
          action: 'REPAIR_ORDER_IMPORT',
          details: JSON.stringify(counts),
        },
      });
      return completedBatch;
    });
    return res.status(201).json({ batch: updatedBatch, errors });
  } catch (error) {
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'failed' } });
    throw error;
  }
}

export async function getImportHistory(req, res) {
  const where = roleName(req.user.role) === 'CCM'
    ? { importedByUserId: req.user.id }
    : {};
  const imports = await prisma.importBatch.findMany({
    where,
    include: { rowErrors: { orderBy: { rowNumber: 'asc' }, take: 100 } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return res.json({ imports });
}