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
