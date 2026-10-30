import test from 'node:test';
import assert from 'node:assert/strict';
import { appointmentVisibilityWhere, normalizeAppointmentRole } from '../src/utils/appointmentAccess.js';

test('normalizeAppointmentRole handles mixed case and standard roles', () => {
  assert.equal(normalizeAppointmentRole('admin'), 'Admin');
  assert.equal(normalizeAppointmentRole('GM'), 'GM');
  assert.equal(normalizeAppointmentRole('ccm'), 'CCM');
  assert.equal(normalizeAppointmentRole('cre'), 'CRE');
  assert.equal(normalizeAppointmentRole('free_service_cre'), 'FREE_SERVICE_CRE');
});

test('Admin and GM can see and manage all appointments', () => {
  assert.deepEqual(appointmentVisibilityWhere({ role: 'ADMIN' }), {});
  assert.deepEqual(appointmentVisibilityWhere({ role: 'GM' }), {});
});

test('CCM access is limited to their own team', () => {
  const where = appointmentVisibilityWhere({ role: 'CCM', ccmId: 'ccm-team-1' });
  assert.deepEqual(where, {
    ccmId: 'ccm-team-1',
    AND: [
      { OR: [{ customerId: null }, { customer: { is: { ccmId: 'ccm-team-1' } } }] },
      { OR: [{ vehicleId: null }, { vehicle: { is: { ccmId: 'ccm-team-1' } } }] },
    ],
  });
});

test('CRE appointment visibility also requires a currently assigned team customer and vehicle', () => {
  const user = { id: 'cre-user-1', role: 'CRE', ccmId: 'ccm-team-1' };
  const where = appointmentVisibilityWhere(user);
  assert.equal(where.ccmId, 'ccm-team-1');
  assert.deepEqual(where.OR, [
    { assigneeId: 'cre-user-1' },
    { createdById: 'cre-user-1' },
  ]);
  assert.deepEqual(where.AND[0], {
    customer: {
      is: {
        ccmId: 'ccm-team-1',
        vehicles: {
          some: {
            OR: [
              { allocations: { some: { creId: 'cre-user-1', ccmId: 'ccm-team-1', status: 'assigned' } } },
              { masterCallListEntries: { some: { ownerUserId: 'cre-user-1', ccmId: 'ccm-team-1' } } },
            ],
          },
        },
      },
    },
  });
});

test('CRE with missing team or ID is safely locked to no-access', () => {
  const where = appointmentVisibilityWhere({ role: 'CRE' });
  assert.equal(where.ccmId, 'no-access');
  assert.deepEqual(where.OR, [
    { assigneeId: 'no-access' },
    { createdById: 'no-access' },
  ]);
});

test('Free-Service CRE can only access its own customerless appointments', () => {
  assert.deepEqual(appointmentVisibilityWhere({
    id: 'free-service-cre-1',
    role: 'FREE_SERVICE_CRE',
    ccmId: 'ccm-team-1',
  }), {
    ccmId: 'ccm-team-1',
    createdById: 'free-service-cre-1',
    customerId: null,
    OR: [
      { vehicleId: null },
      { vehicle: { is: { ccmId: 'ccm-team-1' } } },
    ],
  });
});

test('unknown appointment roles fail closed', () => {
  assert.deepEqual(appointmentVisibilityWhere({ role: 'AUDITOR', id: 'user-1' }), { id: 'no-access' });
});
