import { deriveCreCallAggregateRows, lockCreAggregates } from './creCallAggregates.js';
import { markCreSnapshotsDirty } from './performanceSnapshotState.js';

function rowKey(row) {
  const date = row.workshopDate instanceof Date ? row.workshopDate.toISOString().slice(0, 10) : String(row.workshopDate);
  return `${row.ccmId}|${date}|${row.callSource}|${row.scopeKind}`;
}

// Compares the stored cre_call_daily rows of one user with what call_logs currently imply. Read-only.
export async function auditCreCallAggregates(db, userId) {
  const [expectedRows, storedRows] = await Promise.all([
    deriveCreCallAggregateRows(db, userId),
    db.creCallDaily.findMany({ where: { userId } }),
  ]);
  const expected = new Map(expectedRows.map((row) => [rowKey(row), row]));
  const stored = new Map(storedRows.filter((row) => row.calls > 0 || row.answeredCalls > 0).map((row) => [rowKey(row), row]));
  const mismatches = [];
  for (const [key, want] of expected) {
    const have = stored.get(key);
    if (!have) mismatches.push({ key, kind: 'missing', expected: { calls: want.calls, answeredCalls: want.answeredCalls } });
    else if (have.calls !== want.calls || have.answeredCalls !== want.answeredCalls) {
      mismatches.push({
        key,
        kind: 'differs',
        expected: { calls: want.calls, answeredCalls: want.answeredCalls },
        stored: { calls: have.calls, answeredCalls: have.answeredCalls },
      });
    }
  }
  for (const [key, have] of stored) {
    if (!expected.has(key)) mismatches.push({ key, kind: 'extra', stored: { calls: have.calls, answeredCalls: have.answeredCalls } });
  }
  return { userId, expectedRows: expected.size, storedRows: stored.size, mismatches };
}

// Under the per-user lock, rewrites the user's rows only if they differ from call_logs. One transaction per
// user, so a failure leaves that user's previous rows untouched. Idempotent: a second run changes nothing.
export async function repairCreCallAggregates(prisma, userId, { markSnapshotsDirty = true } = {}) {
  return prisma.$transaction(async (transaction) => {
    await lockCreAggregates(transaction, userId);
    const audit = await auditCreCallAggregates(transaction, userId);
    if (!audit.mismatches.length) return { userId, changed: false, mismatches: 0 };
    await transaction.creCallDaily.deleteMany({ where: { userId } });
    const rows = await deriveCreCallAggregateRows(transaction, userId);
    if (rows.length) await transaction.creCallDaily.createMany({ data: rows });
    if (markSnapshotsDirty) await markCreSnapshotsDirty(transaction, { creIds: [userId] });
    return { userId, changed: true, mismatches: audit.mismatches.length };
  }, { timeout: 120000, maxWait: 30000 });
}

// Users that can own aggregate rows: anyone who logged a call, plus anyone who already has stored rows.
export async function listAggregateUserIds(db) {
  const [callers, stored] = await Promise.all([
    db.callLog.groupBy({ by: ['createdById'], where: { createdById: { not: null } } }),
    db.creCallDaily.groupBy({ by: ['userId'] }),
  ]);
  return [...new Set([...callers.map((row) => row.createdById), ...stored.map((row) => row.userId)])].sort();
}
