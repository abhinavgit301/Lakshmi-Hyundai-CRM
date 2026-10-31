import { importSnapshotValuesMatch } from './importBatchStats.js';

export function importSnapshot(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function isSnapshot(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertChangeEvidence({
  importBatchId,
  rowProgressId,
  evidenceScope,
  sequence,
  entityType,
  entityId,
  operation,
  before,
  after,
}) {
  if (!importBatchId || !entityType || !entityId) {
    throw new TypeError('Import change evidence requires a batch ID, entity type, and entity ID.');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('Import change evidence requires a positive integer sequence.');
  }
  if (!['row', 'batch'].includes(evidenceScope)
    || (evidenceScope === 'row' && !rowProgressId)
    || (evidenceScope === 'batch' && rowProgressId !== null)) {
    throw new TypeError('Import change evidence has an invalid row-progress scope.');
  }
  if (!['CREATE', 'UPDATE'].includes(operation)
    || !isSnapshot(before)
    || !isSnapshot(after)) {
    throw new TypeError('Import change evidence requires a supported operation and object snapshots.');
  }
  const beforeFields = Object.keys(before).sort();
  const afterFields = Object.keys(after).sort();
  if (operation === 'CREATE') {
    if (beforeFields.length || after.id !== entityId || !afterFields.length) {
      throw new TypeError('CREATE evidence must contain an empty before snapshot and a complete after snapshot.');
    }
    return;
  }
  if (!beforeFields.length
    || beforeFields.length !== afterFields.length
    || beforeFields.some((field, index) => field !== afterFields[index])) {
    throw new TypeError('UPDATE evidence must capture matching, non-empty before and after field sets.');
  }
  if (!beforeFields.some((field) => field !== 'updatedAt'
    && !importSnapshotValuesMatch(before[field], after[field]))) {
    throw new TypeError('UPDATE evidence must contain at least one changed business field.');
  }
}

export async function recordImportChange(transaction, {
  importBatchId,
  rowProgressId = null,
  evidenceScope = 'row',
  sequence,
  entityType,
  entityId,
  ccmId = null,
  operation,
  before = {},
  after = {},
}) {
  const beforeSnapshot = importSnapshot(before);
  const afterSnapshot = importSnapshot(after);
  assertChangeEvidence({
    importBatchId,
    rowProgressId,
    evidenceScope,
    sequence,
    entityType,
    entityId,
    operation,
    before: beforeSnapshot,
    after: afterSnapshot,
  });
  return transaction.importChangeLog.create({
    data: {
      importBatchId,
      rowProgressId,
      evidenceScope,
      sequence,
      entityType,
      entityId,
      ccmId,
      operation,
      before: beforeSnapshot,
      after: afterSnapshot,
    },
  });
}
