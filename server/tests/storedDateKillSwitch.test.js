import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { loadDueCohorts } from '../src/controllers/recordsController.js';

async function capturedWhere(options) {
  const original = prisma.masterCallList.findMany;
  const wheres = [];
  prisma.masterCallList.findMany = async (args) => { wheres.push(args.where); return []; };
  try {
    await loadDueCohorts({ ccmId: 'ccm-1' }, new Date(2026, 10, 4), { role: 'CCM', ccmId: 'ccm-1' }, options);
  } finally {
    prisma.masterCallList.findMany = original;
  }
  return JSON.stringify(wheres);
}

test('stored last-service-date narrowing is disabled because it is not service-type aware', async () => {
  assert.equal((await capturedWhere({ useStoredLastServiceDate: false })).includes('lastServiceDate'), false);
  assert.equal((await capturedWhere({})).includes('lastServiceDate'), false);
  assert.equal((await capturedWhere({ useStoredLastServiceDate: true })).includes('lastServiceDate'), false);
});
