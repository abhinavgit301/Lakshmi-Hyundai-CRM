export function importSnapshot(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
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
      before: importSnapshot(before),
      after: importSnapshot(after),
    },
  });
}
