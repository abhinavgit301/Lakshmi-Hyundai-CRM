import assert from 'node:assert/strict';
import test from 'node:test';
import { addOriginatingDealerCodes } from '../src/utils/serviceHistoryDealerCodes.js';

test('service history dealer codes come from each visit origin CCM, independent of viewer context', async () => {
  const visits = [
    { id: 'visit-a1', ccmId: 'ccm-a', dealerCode: 'wrong-current-viewer-code' },
    { id: 'visit-b1', ccmId: 'ccm-b' },
    { id: 'visit-a2', ccmId: 'ccm-a' },
    { id: 'visit-unknown', ccmId: 'ccm-missing' },
    { id: 'visit-no-origin', ccmId: null },
  ];
  let query;
  const database = {
    user: {
      findMany: async (args) => {
        query = args;
        return [
          { ccmId: 'ccm-a', dealerCode: 'A001' },
          { ccmId: 'ccm-b', dealerCode: 'B002' },
        ];
      },
    },
  };

  const result = await addOriginatingDealerCodes(visits, database);

  assert.deepEqual(result.map(({ dealerCode }) => dealerCode), ['A001', 'B002', 'A001', null, null]);
  assert.deepEqual(query.where, { role: 'CCM', ccmId: { in: ['ccm-a', 'ccm-b', 'ccm-missing'] } });
  assert.deepEqual(query.select, { ccmId: true, dealerCode: true });
});

test('service history dealer-code lookups split large CCM ID lists into bounded queries', async () => {
  const ccmIds = Array.from({ length: 501 }, (_, index) => `ccm-${index}`);
  const visits = ccmIds.map((ccmId) => ({ id: `visit-${ccmId}`, ccmId }));
  const querySizes = [];
  const database = {
    user: {
      findMany: async ({ where }) => {
        querySizes.push(where.ccmId.in.length);
        return where.ccmId.in.map((ccmId) => ({ ccmId, dealerCode: `dealer-${ccmId}` }));
      },
    },
  };

  const result = await addOriginatingDealerCodes(visits, database);

  assert.deepEqual(querySizes, [500, 1]);
  assert.equal(result.length, 501);
  assert.equal(result[500].dealerCode, 'dealer-ccm-500');
});
