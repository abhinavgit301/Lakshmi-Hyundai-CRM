import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeIneligibleFreeServiceFollowUps, isStreamedFollowUpEligibilityEnabled } from '../src/utils/serviceLists.js';

test('streamed follow-up eligibility is disabled unless explicitly enabled', () => {
  assert.equal(isStreamedFollowUpEligibilityEnabled({}), false);
  assert.equal(isStreamedFollowUpEligibilityEnabled({ FREE_SERVICE_FOLLOW_UP_STREAMED_ELIGIBILITY_ENABLED: 'yes' }), false);
  assert.equal(isStreamedFollowUpEligibilityEnabled({ FREE_SERVICE_FOLLOW_UP_STREAMED_ELIGIBILITY_ENABLED: 'TRUE' }), true);
  assert.equal(isStreamedFollowUpEligibilityEnabled({ FREE_SERVICE_FOLLOW_UP_STREAMED_ELIGIBILITY_ENABLED: '1' }), true);
});

test('free-service eligibility loads scoped history in bounded batches and preserves exclusion semantics', async () => {
  const user = { id: 'cre', ccmId: 'team', role: 'CRE' };
  const candidates = Array.from({ length: 1001 }, (_, index) => ({
    id: `follow-${index}`,
    vehicle: { physicalVehicleId: `physical-${index}`, saleDate: new Date('2000-01-01T00:00:00Z') },
    milestone: null,
  }));
  candidates.push({ id: 'unlinked', vehicle: null, milestone: null });
  const queries = [];
  const db = {
    followUp: { findMany: async ({ where }) => { assert.equal(where.source, 'FREE_SERVICE'); return candidates; } },
    workshopVisit: { findMany: async ({ where }) => {
      queries.push(where);
      return where.physicalVehicleId.in.includes('physical-1000')
        ? [{ id: 'paid', physicalVehicleId: 'physical-1000', visitDate: new Date('2000-02-01T00:00:00Z'), importedDetails: { workType: 'Paid Service' } }]
        : [];
    } },
  };
  const original = { ccmId: 'team', source: { in: ['SERVICE', 'FREE_SERVICE'] }, AND: [{ status: 'pending' }] };
  const result = await excludeIneligibleFreeServiceFollowUps(original, user, db);
  assert.deepEqual(queries.map((query) => query.physicalVehicleId.in.length), [500, 500, 1]);
  assert.ok(queries.every((query) => query.physicalVehicle.is.vehicles.some.ccmId === 'team'));
  assert.deepEqual(result.AND[0], { status: 'pending' });
  assert.deepEqual(result.AND[1], { OR: [
    { source: { not: 'FREE_SERVICE' } },
    { id: { notIn: ['follow-1000', 'unlinked'] } },
  ] });
  assert.equal(original.AND.length, 1);
});

test('eligibility propagates later batch failures', async () => {
  const error = new Error('history query failed');
  let queries = 0;
  const db = {
    followUp: { findMany: async () => Array.from({ length: 501 }, (_, i) => ({
      id: String(i), vehicle: { physicalVehicleId: String(i) }, milestone: null,
    })) },
    workshopVisit: { findMany: async () => { if (++queries === 2) throw error; return []; } },
  };
  await assert.rejects(excludeIneligibleFreeServiceFollowUps({ source: 'FREE_SERVICE' }, { role: 'CCM', ccmId: 'team' }, db), (actual) => actual === error);
  assert.equal(queries, 2);
});

test('eligibility skips queries for unrelated service sources', async () => {
  const where = { source: 'WARRANTY' };
  assert.equal(await excludeIneligibleFreeServiceFollowUps(where, {}, {}), where);
});

test('streamed eligibility matches legacy with shared histories, distinct sale dates and preserved candidate order', async () => {
  const flag = 'FREE_SERVICE_FOLLOW_UP_STREAMED_ELIGIBILITY_ENABLED';
  const previous = process.env[flag];
  const now = new Date();
  const saleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 45);
  const laterSaleDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10);
  const visitDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 25);
  const candidates = [
    { id: 'unlinked', vehicle: null, milestone: null },
    ...Array.from({ length: 501 }, (_, i) => ({
      id: `follow-${i}`, vehicle: { physicalVehicleId: `physical-${i}`, saleDate }, milestone: { milestone: 1 },
    })),
    { id: 'shared-later-sale', vehicle: { physicalVehicleId: 'physical-0', saleDate: laterSaleDate }, milestone: { milestone: 1 } },
    { id: 'shared-second', vehicle: { physicalVehicleId: 'physical-0', saleDate }, milestone: { milestone: 2 } },
  ];
  let queries = 0;
  let processedFirstBatch = false;
  let assertStreamed = false;
  const db = {
    followUp: { findMany: async () => candidates },
    workshopVisit: { findMany: async ({ where }) => {
      queries += 1;
      if (queries === 2 && assertStreamed) assert.equal(processedFirstBatch, true);
      return where.physicalVehicleId.in.includes('physical-0') ? [{
        id: 'free', physicalVehicleId: 'physical-0', visitDate,
        get importedDetails() { processedFirstBatch = true; return { workType: 'Free Service' }; },
      }] : where.physicalVehicleId.in.includes('physical-500') ? [{
        id: 'paid', physicalVehicleId: 'physical-500', visitDate, importedDetails: { workType: 'Paid Service' },
      }] : [];
    } },
  };
  const where = { source: 'FREE_SERVICE', status: 'pending' };
  try {
    delete process.env[flag];
    const legacy = await excludeIneligibleFreeServiceFollowUps(where, { role: 'CCM', ccmId: 'team' }, db);
    assert.deepEqual(legacy.AND, [{ id: { notIn: ['unlinked', 'follow-0', 'follow-500'] } }]);
    process.env[flag] = 'true';
    queries = 0;
    processedFirstBatch = false;
    assertStreamed = true;
    const streamed = await excludeIneligibleFreeServiceFollowUps(where, { role: 'CCM', ccmId: 'team' }, db);
    assert.deepEqual(streamed, legacy);
    assert.equal(queries, 2);
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test('streamed eligibility propagates later history failures', async () => {
  const flag = 'FREE_SERVICE_FOLLOW_UP_STREAMED_ELIGIBILITY_ENABLED';
  const previous = process.env[flag];
  const error = new Error('later history query failed');
  let queries = 0;
  const db = {
    followUp: { findMany: async () => Array.from({ length: 501 }, (_, i) => ({
      id: String(i), vehicle: { physicalVehicleId: String(i) }, milestone: null,
    })) },
    workshopVisit: { findMany: async () => { if (++queries === 2) throw error; return []; } },
  };
  try {
    process.env[flag] = 'true';
    await assert.rejects(excludeIneligibleFreeServiceFollowUps({ source: 'FREE_SERVICE' }, { role: 'CCM', ccmId: 'team' }, db), (actual) => actual === error);
    assert.equal(queries, 2);
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});
