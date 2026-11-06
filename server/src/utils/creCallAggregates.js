import { creCustomerWhere, creVehicleWhere } from './creAccess.js';
import { isAnsweredOutcome } from './serviceCalendar.js';
import { zonedDateKey } from './workshopTime.js';
import { isPerformanceAggregateMaintenanceEnabled, markCreSnapshotsDirty } from './performanceSnapshotState.js';

// Immediate-tier aggregate. cre_call_daily mirrors exactly what the live call-count queries return:
//   OWNED - calls on customers/vehicles the CRE currently owns (CRE dashboard and performance summary scope)
//   TEAM  - calls inside the CCM team (Free-Service CRE and CCM quota board scope)
// Every CallLog write must go through addCallToAggregates / removeCallFromAggregates inside the same
// transaction, and every ownership change flushes through flushCreCallAggregates.

export const SCOPE_KINDS = ['OWNED', 'TEAM'];

export function aggregateScopeWhere(kind, { userId, ccmId }) {
  if (kind === 'TEAM') {
    return {
      ccmId,
      OR: [
        { vehicleId: null, customer: { is: { ccmId } } },
        { vehicle: { is: { ccmId } } },
      ],
    };
  }
  const owner = { id: userId, ccmId };
  return {
    ccmId,
    customer: { is: creCustomerWhere(owner) },
    AND: [{
      OR: [
        { vehicleId: null },
        { vehicle: { is: { ccmId, ...creVehicleWhere(owner) } } },
      ],
    }],
  };
}

export function workshopDateValue(date) {
  return new Date(`${zonedDateKey(date)}T00:00:00.000Z`);
}

async function applyDelta(transaction, { userId, ccmId, createdAt, callSource, kind, calls, answered }) {
  const workshopDate = workshopDateValue(createdAt);
  await transaction.$executeRaw`
    INSERT INTO "cre_call_daily" ("userId", "ccmId", "workshopDate", "callSource", "scopeKind", "calls", "answeredCalls", "updatedAt")
    VALUES (${userId}, ${ccmId}, ${workshopDate}::date, ${callSource}::"CallSource", ${kind}, ${Math.max(calls, 0)}, ${Math.max(answered, 0)}, now())
    ON CONFLICT ("userId", "ccmId", "workshopDate", "callSource", "scopeKind")
    DO UPDATE SET "calls" = GREATEST("cre_call_daily"."calls" + ${calls}, 0),
                  "answeredCalls" = GREATEST("cre_call_daily"."answeredCalls" + ${answered}, 0),
                  "updatedAt" = now()`;
}

async function applyCall(transaction, callLog, sign) {
  if (!isPerformanceAggregateMaintenanceEnabled()) return;
  if (!callLog?.createdById || !callLog.ccmId) return;
  const answered = isAnsweredOutcome(callLog.outcome) ? 1 : 0;
  await lockCreAggregates(transaction, callLog.createdById);
  for (const kind of SCOPE_KINDS) {
    // The row must still exist so the scope is evaluated with the same live joins as the dashboard queries.
    const inScope = await transaction.callLog.count({
      where: { id: callLog.id, createdById: callLog.createdById, ...aggregateScopeWhere(kind, { userId: callLog.createdById, ccmId: callLog.ccmId }) },
    });
    if (!inScope) continue;
    await applyDelta(transaction, {
      userId: callLog.createdById,
      ccmId: callLog.ccmId,
      createdAt: callLog.createdAt,
      callSource: callLog.callSource,
      kind,
      calls: sign,
      answered: sign * answered,
    });
  }
}

// Call right after creating the CallLog, inside the same transaction.
export function addCallToAggregates(transaction, callLog) {
  return applyCall(transaction, callLog, 1);
}

// Call BEFORE deleting a CallLog or changing its outcome, source, creator or date. An edit is
// remove(before) -> update -> add(after).
export function removeCallFromAggregates(transaction, callLog) {
  return applyCall(transaction, callLog, -1);
}

// Derives the aggregate rows for one user straight from call_logs with the live scope rules. Read-only:
// the rebuild, the reconciliation script and the parity tests all use it.
export async function deriveCreCallAggregateRows(db, userId) {
  const ccmGroups = await db.callLog.groupBy({
    by: ['ccmId'],
    where: { createdById: userId, ccmId: { not: null } },
  });
  const rows = new Map();
  for (const { ccmId } of ccmGroups) {
    for (const kind of SCOPE_KINDS) {
      const calls = await db.callLog.findMany({
        where: { createdById: userId, ...aggregateScopeWhere(kind, { userId, ccmId }) },
        select: { createdAt: true, outcome: true, callSource: true },
      });
      for (const call of calls) {
        const key = `${ccmId}|${zonedDateKey(call.createdAt)}|${call.callSource}|${kind}`;
        const row = rows.get(key) || {
          userId, ccmId, workshopDate: workshopDateValue(call.createdAt), callSource: call.callSource, scopeKind: kind, calls: 0, answeredCalls: 0,
        };
        row.calls += 1;
        if (isAnsweredOutcome(call.outcome)) row.answeredCalls += 1;
        rows.set(key, row);
      }
    }
  }
  return [...rows.values()];
}

// Serialises writers per user: a delta for a new call and a rebuild of the same user can never interleave.
// The lock is taken after the CallLog insert, so whichever transaction goes second sees the other's result.
export async function lockCreAggregates(transaction, userId) {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`cre_call_daily:${userId}`}, 0))`;
}

// Re-derives every aggregate row for the given users from call_logs with the live scope rules.
export async function rebuildCreCallAggregates(transaction, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))].sort();
  for (const userId of ids) {
    await lockCreAggregates(transaction, userId);
    await transaction.creCallDaily.deleteMany({ where: { userId } });
    const rows = await deriveCreCallAggregateRows(transaction, userId);
    if (rows.length) await transaction.creCallDaily.createMany({ data: rows });
  }
}

const pendingChanges = new WeakMap();

function pendingEntry(transaction) {
  let entry = pendingChanges.get(transaction);
  if (!entry) {
    entry = { ownershipCreIds: new Set(), accountCreIds: new Set(), previousCcms: new Map(), deletedCreIds: new Set() };
    pendingChanges.set(transaction, entry);
  }
  return entry;
}

// Called by every CRE ownership event. The change is applied by flushCreCallAggregates at the end of the
// transaction, once the ownership rows have their final state.
export function noteCreOwnershipChange(transaction, { creIds }) {
  if (!isPerformanceAggregateMaintenanceEnabled()) return;
  const entry = pendingEntry(transaction);
  for (const id of creIds) if (id) entry.ownershipCreIds.add(id);
}

// Customer and vehicle changes can alter the live ownership joins for existing calls. Capture the
// callers before the change (or deletion); flushCreCallAggregates re-derives their rows before commit.
export async function noteCreCallEntityScopeChange(transaction, { customerIds = [], vehicleIds = [] }) {
  if (!isPerformanceAggregateMaintenanceEnabled()) return;
  const vehicleIdSet = [...new Set(vehicleIds.filter(Boolean))];
  const affectedVehicleCustomers = vehicleIdSet.length
    ? await transaction.vehicle.findMany({
      where: { id: { in: vehicleIdSet } },
      select: { customerId: true },
    })
    : [];
  const customerIdSet = [...new Set([
    ...customerIds.filter(Boolean),
    ...affectedVehicleCustomers.map(({ customerId }) => customerId).filter(Boolean),
  ])];
  const OR = [];
  if (customerIdSet.length) {
    OR.push(
      { customerId: { in: customerIdSet } },
      { vehicle: { is: { customerId: { in: customerIdSet } } } },
    );
  }
  if (vehicleIdSet.length) OR.push({ vehicleId: { in: vehicleIdSet } });
  if (!OR.length) return;

  const callers = await transaction.callLog.groupBy({
    by: ['createdById'],
    where: { createdById: { not: null }, OR },
  });
  const entry = pendingEntry(transaction);
  for (const { createdById } of callers) if (createdById) entry.ownershipCreIds.add(createdById);
}

// A CRE's role, Free Service / Warranty access, CCM or status changed. Every month's snapshot for the CRE
// depends on those flags (they decide which service categories the live calculation counts), so all months
// are flagged and, when the CCM changed, the old CCM's snapshots are removed.
export function noteCreAccountChange(transaction, { creId, previousCcmId = null, nextCcmId = null }) {
  if (!isPerformanceAggregateMaintenanceEnabled() || !creId) return;
  const entry = pendingEntry(transaction);
  entry.accountCreIds.add(creId);
  if (previousCcmId && previousCcmId !== nextCcmId) {
    const ccms = entry.previousCcms.get(creId) || new Set();
    ccms.add(previousCcmId);
    entry.previousCcms.set(creId, ccms);
  }
}

const CRE_ROLES = ['CRE', 'FREE_SERVICE_CRE'];
const ACCOUNT_FIELDS = ['role', 'ccmId', 'status', 'freeServiceEnabled', 'warrantyEnabled'];

// Role, CCM, status and the Free Service / Warranty flags decide how a CRE's performance snapshots are
// calculated. Compare the user before and after an update and flag the snapshots when any of them changed.
export function noteCreAccountChangeIfAffected(transaction, before, after) {
  if (!CRE_ROLES.includes(before.role) && !CRE_ROLES.includes(after.role)) return;
  if (!ACCOUNT_FIELDS.some((field) => before[field] !== after[field])) return;
  noteCreAccountChange(transaction, { creId: after.id, previousCcmId: before.ccmId, nextCcmId: after.ccmId });
}

export function noteCreDeleted(transaction, { creId }) {
  if (!isPerformanceAggregateMaintenanceEnabled() || !creId) return;
  const entry = pendingEntry(transaction);
  entry.deletedCreIds.add(creId);
  entry.ownershipCreIds.add(creId);
}

// Re-derives call aggregates for CREs whose ownership changed and flags every affected snapshot, all inside
// the caller's transaction so the dirty state commits (or rolls back) together with the change itself.
export async function flushCreCallAggregates(transaction, { extraCreIds = [] } = {}) {
  if (!isPerformanceAggregateMaintenanceEnabled()) return { creIds: [], changed: false };
  const entry = pendingChanges.get(transaction);
  pendingChanges.delete(transaction);
  if (!entry && !extraCreIds.length) return { creIds: [], changed: false };

  const ownership = [...new Set([...(entry?.ownershipCreIds || []), ...extraCreIds])].filter(Boolean);
  const account = [...(entry?.accountCreIds || [])].filter((id) => !entry.deletedCreIds.has(id));
  const deleted = [...(entry?.deletedCreIds || [])];

  if (ownership.length) await rebuildCreCallAggregates(transaction, ownership);
  const liveOwnership = ownership.filter((id) => !deleted.includes(id));
  if (liveOwnership.length) await markCreSnapshotsDirty(transaction, { creIds: liveOwnership });
  if (account.length) await markCreSnapshotsDirty(transaction, { creIds: account, allMonths: true });
  for (const [creId, ccmIds] of entry?.previousCcms || []) {
    if (!deleted.includes(creId)) {
      await transaction.crePerformanceSnapshot.deleteMany({ where: { creId, ccmId: { in: [...ccmIds] } } });
    }
  }
  if (deleted.length) await transaction.crePerformanceSnapshot.deleteMany({ where: { creId: { in: deleted } } });

  const creIds = [...new Set([...ownership, ...account])];
  return { creIds, changed: creIds.length > 0 };
}
