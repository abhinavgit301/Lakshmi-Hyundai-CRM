import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMasterRepairType, MASTER_REPAIR_TYPES } from '../src/utils/repairTypes.js';

test('master call list repair types normalize to the six supported categories', () => {
  const examples = [
    ['Accidental Repair', 'Accidental Repair'],
    ['Collision repair', 'Accidental Repair'],
    ['Free service', 'Free'],
    ['FOC', 'Free'],
    ['Paid service', 'Paid'],
    ['Customer pay', 'Paid'],
    ['Running Repair', 'Running Repair'],
    ['RR', 'Running Repair'],
    ['Periodic maintenance', 'PMS'],
    ['PMS', 'PMS'],
    ['Other work', 'Others'],
    ['', 'Others'],
  ];
  for (const [input, expected] of examples) {
    assert.equal(classifyMasterRepairType(input), expected);
  }
  assert.deepEqual(new Set(examples.map(([input]) => classifyMasterRepairType(input))), new Set(MASTER_REPAIR_TYPES));
});
