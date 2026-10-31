import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { prisma } from '../config/prisma.js';
import {
  classifyMonthlyRows,
  canAccessCcmMonthlyData,
  monthlyEntryDuplicateKey,
  validateDatasetPeriod,
  validateMonthlyCustomerRow,
} from '../utils/monthlyCustomerDataRules.js';
import { parseMonthlyCustomerDataFile } from '../utils/monthlyCustomerDataParser.js';
import { allocateUnassignedMasterCallListEntries, lockCcmAllocationTeam } from '../utils/customerAllocation.js';
import { findCanonicalMasterCallListEntry } from '../utils/masterCallList.js';
import { findOrCreatePhysicalVehicle } from '../utils/physicalVehicle.js';
import { importSnapshot, recordImportChange } from '../utils/importChangeLog.js';
import { collectImportBatchStats, importRollbackCompleteness } from '../utils/importBatchStats.js';

const FILE_SIZE_LIMIT = 7_000_000;

function userCanAccessCcm(user, ccmId) {
  return canAccessCcmMonthlyData(user, ccmId);
}

async function resolveCcm(ccmId) {
  const ccm = await prisma.user.findFirst({
    where: { ccmId, role: 'CCM' },
    select: { id: true, ccmId: true, name: true, username: true, phone: true, dealerCode: true, gmId: true },
  });
  if (ccm) return ccm;
  const historicalDataset = await prisma.monthlyCustomerDataset.findFirst({ where: { ccmId }, select: { id: true } });
  return historicalDataset ? { id: null, ccmId, name: 'Deleted CCM', username: '', phone: null, dealerCode: null, gmId: null } : null;
}

async function getDataset(ccmUserId, year, month, transaction = prisma) {
  const ccm = await transaction.user.findUnique({ where: { id: ccmUserId }, select: { id: true, ccmId: true } });
  if (!ccm?.ccmId || !ccm.id) throw new Error('CCM account is no longer available for new monthly data.');

  let dataset = await transaction.monthlyCustomerDataset.findUnique({
    where: { ccmId_year_month: { ccmId: ccm.ccmId, year, month } },
  });
  if (!dataset) {
    dataset = await transaction.monthlyCustomerDataset.findUnique({
      where: { ccmUserId_year_month: { ccmUserId, year, month } },
    });
  }
  if (dataset) {
    if (!dataset.ccmId) {
      dataset = await transaction.monthlyCustomerDataset.update({
        where: { id: dataset.id },
        data: { ccmId: ccm.ccmId },
      });
    }
    return dataset;
  }
  return transaction.monthlyCustomerDataset.create({ data: { ccmUserId, ccmId: ccm.ccmId, year, month } });
}

async function findDataset(ccm, year, month) {
  let dataset = await prisma.monthlyCustomerDataset.findUnique({
    where: { ccmId_year_month: { ccmId: ccm.ccmId, year, month } },
  });
  if (!dataset && ccm.id) {
    dataset = await prisma.monthlyCustomerDataset.findUnique({
      where: { ccmUserId_year_month: { ccmUserId: ccm.id, year, month } },
    });
    if (dataset && !dataset.ccmId) {
      dataset = await prisma.monthlyCustomerDataset.update({ where: { id: dataset.id }, data: { ccmId: ccm.ccmId } });
    }
  }
  return dataset;
}

async function getExistingKeys(datasetId, transaction = prisma) {
  const entries = await transaction.monthlyCustomerDataEntry.findMany({
    where: { datasetId },
    select: { vin: true },
  });
  return new Set(entries.map(monthlyEntryDuplicateKey).filter(Boolean));
}

async function loadMonthContext(req, res) {
  const { ccmId } = req.params;
  if (!userCanAccessCcm(req.user, ccmId)) {
    res.status(403).json({ message: 'You cannot access this CCM monthly data.' });
    return null;
  }

  const ccm = await resolveCcm(ccmId);
  if (!ccm) {
    res.status(404).json({ message: 'CCM not found.' });
    return null;
  }

  const period = validateDatasetPeriod(req.query.year, req.query.month);
  if (period.error) {
    res.status(400).json({ message: period.error });
    return null;
  }

  return { ccm, ...period.value };
}

async function persistLinkedEntities(transaction, ccmId, row, trackCreate) {
  const physicalVehicle = row.vin ? await findOrCreatePhysicalVehicle(transaction, row.vin) : null;
  let vehicle = row.vin
    ? await transaction.vehicle.findUnique({
      where: { physicalVehicleId_ccmId: { physicalVehicleId: physicalVehicle.id, ccmId } },
      include: { customer: true },
    })
    : null;
  let customer = vehicle?.customer || null;

  if (!customer) {
    customer = await trackCreate({ entityType: 'Customer', ccmId }, () => transaction.customer.create({
      data: {
        customerCode: `CUS-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        fullName: row.customerName,
        mobileNumber: row.mobileNumber,
        email: row.email,
        ccmId,
      },
    }));
  }

  if (!vehicle && row.vin) {
    vehicle = await trackCreate({ entityType: 'Vehicle', ccmId }, () => transaction.vehicle.create({
      data: {
        vin: row.vin,
        physicalVehicleId: physicalVehicle.id,
        registrationNumber: row.registrationNumber,
        make: row.make,
        model: row.model,
        variant: row.variant,
        year: row.vehicleYear,
        ccmId,
        customerId: customer.id,
      },
    }));
  }

  return { customer, vehicle };
}

// Makes a monthly-imported vehicle visible in the Master Call List and CCM allocation.
// An existing entry is left untouched so its CRE assignment and status are preserved.
async function ensureMasterCallListEntry(transaction, ccmId, links, row, trackCreate, trackUpdate) {
  const { customer, vehicle } = links;
  if (!vehicle?.vin) return;
  const existing = await findCanonicalMasterCallListEntry(transaction, vehicle.vin, ccmId);
  if (existing) {
    if (!existing.vehicleId) {
      await trackUpdate({
        entityType: 'MasterCallList',
        entityId: existing.id,
        ccmId,
        before: { vehicleId: existing.vehicleId, updatedAt: existing.updatedAt },
      }, () => transaction.masterCallList.update({ where: { id: existing.id }, data: { vehicleId: vehicle.id } }));
    }
    return;
  }
  await trackCreate({
    entityType: 'MasterCallList',
    ccmId,
  }, () => transaction.masterCallList.create({
    data: {
      customerName: customer.fullName || row.customerName,
      mobileNumber: customer.mobileNumber || row.mobileNumber,
      vin: vehicle.vin,
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      ccmId,
    },
  }));
}

function monthlyEntryData(datasetId, createdById, ccmId, row, links, source) {
  return {
    datasetId,
    customerId: links.customer.id,
    vehicleId: links.vehicle?.id || null,
    createdById,
    dedupeKey: monthlyEntryDuplicateKey(row) || `row:${randomUUID()}`,
    customerName: row.customerName,
    mobileNumber: row.mobileNumber,
    email: row.email,
    vin: row.vin,
    registrationNumber: row.registrationNumber,
    make: row.make,
    model: row.model,
    vehicleYear: row.vehicleYear,
    serviceType: row.serviceType,
    lastVisitDate: row.lastVisitDate,
    nextServiceDueDate: row.nextServiceDueDate,
    notes: row.notes,
    source,
  };
}

export async function getCcmProfile(req, res) {
  if (String(req.user?.role || '').toUpperCase() !== 'ADMIN') {
    return res.status(403).json({ message: 'Only Admin can open CCM profiles from User Management.' });
  }
  const ccm = await resolveCcm(req.params.ccmId);
  if (!ccm) return res.status(404).json({ message: 'CCM not found.' });

  const [customerCount, vehicleCount, monthlyDatasets] = await Promise.all([
    prisma.customer.count({ where: { ccmId: ccm.ccmId } }),
    prisma.vehicle.count({ where: { ccmId: ccm.ccmId } }),
    prisma.monthlyCustomerDataset.findMany({
      where: { ccmId: ccm.ccmId },
      select: { year: true, month: true, _count: { select: { entries: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    }),
  ]);
  return res.json({ ccm, customerCount, vehicleCount, monthlyDatasets });
}

export async function getMonthlyCustomerData(req, res) {
  const context = await loadMonthContext(req, res);
  if (!context) return;
  const dataset = await findDataset(context.ccm, context.year, context.month);
  const result = dataset ? await prisma.monthlyCustomerDataset.findUnique({
    where: { id: dataset.id },
    include: {
      entries: {
        include: {
          customer: { select: { id: true, customerCode: true } },
          vehicle: { select: { id: true, vin: true, registrationNumber: true, model: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  }) : null;
  return res.json({ dataset: result || null, entries: result?.entries || [] });
}

export async function createMonthlyCustomerEntry(req, res) {
  const context = await loadMonthContext(req, res);
  if (!context) return;
  const validation = validateMonthlyCustomerRow(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const dataset = await getDataset(context.ccm.id, context.year, context.month);
  const key = monthlyEntryDuplicateKey(validation.value);
  const existingKeys = await getExistingKeys(dataset.id);
  if (key && existingKeys.has(key)) return res.status(409).json({ message: 'This vehicle is already in the selected month.' });

  try {
    const entry = await prisma.$transaction(async (transaction) => {
      await lockCcmAllocationTeam(transaction, context.ccm.ccmId);
      const noTrackCreate = (_change, create) => create();
      const noTrackUpdate = (_change, update) => update();
      const links = await persistLinkedEntities(transaction, context.ccm.ccmId, validation.value, noTrackCreate);
      await ensureMasterCallListEntry(transaction, context.ccm.ccmId, links, validation.value, noTrackCreate, noTrackUpdate);
      const createdEntry = await transaction.monthlyCustomerDataEntry.create({
        data: monthlyEntryData(dataset.id, req.user.id, context.ccm.ccmId, validation.value, links, 'manual'),
        include: {
          customer: { select: { id: true, customerCode: true } },
          vehicle: { select: { id: true, vin: true, registrationNumber: true, model: true } },
        },
      });
      await allocateUnassignedMasterCallListEntries(transaction, context.ccm.ccmId, req.user.id);
      return createdEntry;
    });
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'MonthlyCustomerDataEntry',
        entityId: entry.id,
        action: 'MONTHLY_CUSTOMER_ADDED',
        details: JSON.stringify({ ccmId: context.ccm.ccmId, year: context.year, month: context.month }),
      },
    });
    return res.status(201).json({ entry });
  } catch (error) {
    if (error?.code === 'MONTHLY_CCM_CONFLICT') return res.status(409).json({ message: error.message });
    if (error?.code === 'P2002') return res.status(409).json({ message: 'A linked customer or vehicle record already exists.' });
    throw error;
  }
}

async function prepareImport(req, res) {
  const context = await loadMonthContext(req, res);
  if (!context) return null;
  const { fileName, content } = req.body || {};
  const extension = String(fileName || '').split('.').pop().toLowerCase();
  const contentBytes = typeof content === 'string' && extension === 'xlsx'
    ? Math.floor(content.length * 0.75)
    : typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : Infinity;
  if (!fileName || typeof content !== 'string' || contentBytes > FILE_SIZE_LIMIT) {
    res.status(400).json({ message: 'File name and file content are required; maximum file size is 7 MB.' });
    return null;
  }

  const parsed = await parseMonthlyCustomerDataFile({ fileName: path.basename(String(fileName)), content });
  if (parsed.error) {
    res.status(400).json({ message: parsed.error });
    return null;
  }
  if (!parsed.rows.length) {
    res.status(400).json({ message: 'The selected file has no data rows.' });
    return null;
  }

  const dataset = await findDataset(context.ccm, context.year, context.month);
  const existingKeys = dataset ? await getExistingKeys(dataset.id) : new Set();
  const classification = classifyMonthlyRows(parsed.rows, existingKeys);
  return { context, dataset, fileName: path.basename(String(fileName)).slice(0, 255), classification };
}

export async function previewMonthlyCustomerImport(req, res) {
  const prepared = await prepareImport(req, res);
  if (!prepared) return;
  return res.json({
    fileName: prepared.fileName,
    year: prepared.context.year,
    month: prepared.context.month,
    totalRows: prepared.classification.rows.length,
    addedRows: prepared.classification.addedCount,
    skippedRows: prepared.classification.skippedCount,
    rejectedRows: prepared.classification.rejectedCount,
    rows: prepared.classification.rows,
  });
}

export async function importMonthlyCustomerData(req, res) {
  const prepared = await prepareImport(req, res);
  if (!prepared) return;

  const dataset = prepared.dataset || await getDataset(prepared.context.ccm.id, prepared.context.year, prepared.context.month);
  const importBatchId = randomUUID();
  const importRowProgressIds = new Map(prepared.classification.rows.map(({ rowNumber }) => [rowNumber, randomUUID()]));
  const importRecord = await prisma.$transaction(async (transaction) => {
    await transaction.importBatch.create({
      data: {
        id: importBatchId,
        fileName: prepared.fileName,
        importedByUserId: req.user.id,
        ccmId: prepared.context.ccm.ccmId,
        importType: 'monthly_customer_data',
        processingStartedAt: new Date(),
        totalRows: prepared.classification.rows.length,
        status: 'processing',
        rollbackSupported: false,
        statsComplete: false,
        rowProgress: {
          create: prepared.classification.rows.map(({ rowNumber }) => ({
            id: importRowProgressIds.get(rowNumber),
            rowNumber,
          })),
        },
      },
    });
    return transaction.monthlyCustomerDataImport.create({
      data: {
        datasetId: dataset.id,
        importedById: req.user.id,
        fileName: prepared.fileName,
        totalRows: prepared.classification.rows.length,
        status: 'processing',
        importBatchId,
      },
    });
  });

  let addedRows = 0;
  let skippedRows = 0;
  let rejectedRows = 0;
  let changeSequence = 0;
  const rowErrors = [];
  const seenKeys = await getExistingKeys(dataset.id);
  const completeRow = async (transaction, rowProgressId, outcome, loggedChangeCount) => {
    await transaction.importRowProgress.update({
      where: { id: rowProgressId },
      data: {
        status: 'completed',
        outcome,
        mutationState: 'complete',
        loggedChangeCount,
      },
    });
  };
  const trackCreate = async (transaction, rowProgressId, change, create) => {
    const record = await create();
    await recordImportChange(transaction, {
      importBatchId,
      rowProgressId,
      sequence: ++changeSequence,
      ...change,
      entityId: record.id,
      operation: 'CREATE',
      before: {},
      after: importSnapshot(record),
    });
    return record;
  };
  const trackUpdate = async (transaction, rowProgressId, change, update) => {
    const record = await update();
    const after = Object.fromEntries(Object.keys(change.before).map((field) => [field, record[field]]));
    await recordImportChange(transaction, {
      importBatchId,
      rowProgressId,
      sequence: ++changeSequence,
      ...change,
      operation: 'UPDATE',
      after: importSnapshot(after),
    });
    return record;
  };

  let importFinalized = false;
  try {
    for (const item of prepared.classification.rows) {
      const rowProgressId = importRowProgressIds.get(item.rowNumber);
      if (item.status === 'rejected' || item.status === 'skipped') {
        if (item.status === 'rejected') rejectedRows += 1;
        else skippedRows += 1;
        await prisma.importRowProgress.update({
          where: { id: rowProgressId },
          data: {
            status: 'completed',
            outcome: item.status,
            mutationState: 'complete',
            loggedChangeCount: 0,
          },
        });
        rowErrors.push({
          importId: importRecord.id,
          rowNumber: item.rowNumber,
          errorCode: item.status === 'skipped' ? 'DUPLICATE' : 'VALIDATION',
          errorMessage: item.error,
          customerName: String(item.row.customerName || '').slice(0, 200) || null,
          mobileNumber: String(item.row.mobileNumber || '').slice(0, 30) || null,
          vin: String(item.row.vin || '').slice(0, 17) || null,
        });
        continue;
      }

      const key = monthlyEntryDuplicateKey(item.row);
      if (key && seenKeys.has(key)) {
        skippedRows += 1;
        await prisma.importRowProgress.update({
          where: { id: rowProgressId },
          data: { status: 'completed', outcome: 'skipped', mutationState: 'complete', loggedChangeCount: 0 },
        });
        rowErrors.push({
          importId: importRecord.id,
          rowNumber: item.rowNumber,
          errorCode: 'DUPLICATE',
          errorMessage: 'Customer or vehicle was added by an earlier row in this import.',
          customerName: item.row.customerName,
          mobileNumber: item.row.mobileNumber,
          vin: item.row.vin,
        });
        continue;
      }

      try {
        await prisma.$transaction(async (transaction) => {
          await lockCcmAllocationTeam(transaction, prepared.context.ccm.ccmId);
          const trackRowCreate = (change, create) => trackCreate(transaction, rowProgressId, change, create);
          const trackRowUpdate = (change, update) => trackUpdate(transaction, rowProgressId, change, update);
          const links = await persistLinkedEntities(
            transaction,
            prepared.context.ccm.ccmId,
            item.row,
            trackRowCreate,
          );
          await ensureMasterCallListEntry(
            transaction,
            prepared.context.ccm.ccmId,
            links,
            item.row,
            trackRowCreate,
            trackRowUpdate,
          );
          await trackRowCreate({
            entityType: 'MonthlyCustomerDataEntry',
            ccmId: prepared.context.ccm.ccmId,
          }, () => transaction.monthlyCustomerDataEntry.create({
            data: monthlyEntryData(dataset.id, req.user.id, prepared.context.ccm.ccmId, item.row, links, 'import'),
          }));
          const rowChangeCount = await transaction.importChangeLog.count({ where: { importBatchId, rowProgressId } });
          await completeRow(transaction, rowProgressId, 'monthly_added', rowChangeCount);
        });
        if (key) seenKeys.add(key);
        addedRows += 1;
      } catch (error) {
        if (error?.code !== 'P2002' && error?.code !== 'MONTHLY_CCM_CONFLICT') throw error;
        skippedRows += 1;
        await prisma.importRowProgress.update({
          where: { id: rowProgressId },
          data: { status: 'completed', outcome: 'skipped', mutationState: 'complete', loggedChangeCount: 0 },
        });
        rowErrors.push({
          importId: importRecord.id,
          rowNumber: item.rowNumber,
          errorCode: error?.code === 'MONTHLY_CCM_CONFLICT' ? 'CCM_OWNERSHIP_CONFLICT' : 'LINK_CONFLICT',
          errorMessage: error.message || 'A matching unique customer or vehicle identifier already exists.',
          customerName: item.row.customerName,
          mobileNumber: item.row.mobileNumber,
          vin: item.row.vin,
        });
      }
    }

    await prisma.$transaction(async (transaction) => {
      let allocationChangeCount = 0;
      await allocateUnassignedMasterCallListEntries(transaction, prepared.context.ccm.ccmId, req.user.id, {
        spreadAcrossTeam: true,
        onMutation: async (change, update) => {
          const record = await update();
          const after = Object.fromEntries(Object.keys(change.before).map((field) => [field, record[field]]));
          await recordImportChange(transaction, {
            importBatchId,
            sequence: ++changeSequence,
            evidenceScope: 'batch',
            rowProgressId: null,
            ...change,
            operation: 'UPDATE',
            after: importSnapshot(after),
          });
          allocationChangeCount += 1;
          return record;
        },
      });
      if (rowErrors.length) {
        await transaction.monthlyCustomerDataImportRowError.createMany({ data: rowErrors });
      }
      const stats = await collectImportBatchStats(transaction, importBatchId);
      await transaction.importBatch.update({
        where: { id: importBatchId },
        data: {
          ...stats,
          status: 'completed',
          allocationEvidenceState: allocationChangeCount ? 'complete' : 'not_started',
          allocationChangeCount,
          rollbackSupported: false,
          statsComplete: true,
        },
      });
      const rollbackSupported = await importRollbackCompleteness(transaction, importBatchId, prepared.classification.rows.length);
      await transaction.importBatch.update({
        where: { id: importBatchId },
        data: { rollbackSupported, affectedCountsComplete: rollbackSupported },
      });
      await transaction.monthlyCustomerDataImport.update({
        where: { id: importRecord.id },
        data: { addedRows, skippedRows, rejectedRows, status: 'completed' },
      });
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          entityType: 'MonthlyCustomerDataImport',
          entityId: importRecord.id,
          action: 'MONTHLY_CUSTOMER_DATA_IMPORTED',
          details: JSON.stringify({ ccmId: prepared.context.ccm.ccmId, year: prepared.context.year, month: prepared.context.month, addedRows, skippedRows, rejectedRows }),
        },
      });
    });
    importFinalized = true;
  } catch (error) {
    if (!importFinalized) {
      await prisma.$transaction(async (transaction) => {
        await transaction.monthlyCustomerDataImport.update({ where: { id: importRecord.id }, data: { status: 'failed' } });
        await transaction.importBatch.updateMany({
          where: { id: importBatchId, status: 'processing' },
          data: { status: 'failed', rollbackSupported: false, affectedCountsComplete: false },
        });
      });
    }
    throw error;
  }
  const completedImport = await prisma.monthlyCustomerDataImport.findUnique({ where: { id: importRecord.id }, include: { rowErrors: true } });
  return res.status(201).json({ import: completedImport });
}

export async function getMonthlyCustomerImportHistory(req, res) {
  const context = await loadMonthContext(req, res);
  if (!context) return;
  const dataset = await findDataset(context.ccm, context.year, context.month);
  if (!dataset) return res.json({ imports: [] });

  const imports = await prisma.monthlyCustomerDataImport.findMany({
    where: { datasetId: dataset.id },
    include: {
      importedBy: { select: { id: true, name: true } },
      rowErrors: { orderBy: { rowNumber: 'asc' }, take: 200 },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({
    imports: imports.map((monthlyImport) => ({
      ...monthlyImport,
      importedBy: monthlyImport.importedBy || (monthlyImport.importedByIdSnapshot
        ? {
          id: monthlyImport.importedByIdSnapshot,
          name: monthlyImport.importedByNameSnapshot,
          username: monthlyImport.importedByUsernameSnapshot,
        }
        : null),
    })),
  });
}