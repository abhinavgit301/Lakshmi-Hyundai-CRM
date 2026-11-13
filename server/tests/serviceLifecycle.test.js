import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDueCohorts } from '../src/controllers/recordsController.js';
import {
  countRemainingFreeServiceMilestones,
  findCompletingVisit,
  freeServiceCustomerIdsForMonth,
  freeServiceDueDate,
  getServiceLifecycle,
} from '../src/utils/serviceCalendar.js';

const asOf = new Date(2026, 10, 13, 12);
const saleDate = new Date(2023, 10, 10);
const completedFreeVisits = [
  { id: 'free-1', visitDate: new Date(2024, 0, 12), importedDetails: { workType: 'Free Service' } },
  { id: 'free-2', visitDate: new Date(2024, 10, 12), importedDetails: { workType: 'FOC Service' } },
  { id: 'free-3', visitDate: new Date(2025, 10, 12), importedDetails: { workType: 'Free Service' } },
];

test('vehicles in the free phase do not get a regular service reference', () => {
  const noHistory = getServiceLifecycle({ saleDate, workshopVisits: [] }, asOf);
  assert.equal(noHistory.phase, 'free');
  assert.equal(noHistory.referenceDate, null);

  const lifecycle = getServiceLifecycle({
    saleDate,
    workshopVisits: completedFreeVisits.slice(0, 2),
  }, asOf);

  assert.equal(lifecycle.phase, 'free');
  assert.deepEqual(lifecycle.completedMilestones, [1, 2]);
  assert.equal(lifecycle.referenceDate, null);
});

test('all three free milestones enable regular due dates based on the latest free visit', () => {
  const lifecycle = getServiceLifecycle({ saleDate, workshopVisits: completedFreeVisits }, asOf);
  assert.equal(lifecycle.phase, 'post-free');
  assert.deepEqual(lifecycle.completedMilestones, [1, 2, 3]);
  assert.equal(lifecycle.referenceDate.getTime(), completedFreeVisits[2].visitDate.getTime());

  const cohorts = classifyDueCohorts([{ id: 'vehicle', saleDate, workshopVisits: completedFreeVisits }], asOf);
  assert.equal(cohorts.oneYear.length, 1);
  assert.equal(cohorts.oneYear[0].lastServiceDate.getTime(), completedFreeVisits[2].visitDate.getTime());
});

test('completed free milestones also enter the existing six-month cohort from the latest free visit', () => {
  const sale = new Date(2024, 4, 10);
  const visits = [
    { visitDate: new Date(2024, 6, 12), importedDetails: { workType: 'Free Service' } },
    { visitDate: new Date(2025, 4, 12), importedDetails: { workType: 'Free Service' } },
    { visitDate: new Date(2026, 4, 12), importedDetails: { workType: 'Free Service' } },
  ];
  const cohorts = classifyDueCohorts([{ id: 'vehicle', saleDate: sale, workshopVisits: visits }], asOf);
  assert.equal(cohorts.sixMonth.length, 1);
  assert.equal(cohorts.sixMonth[0].lastServiceDate.getTime(), visits[2].visitDate.getTime());
});

test('any classified paid visit permanently takes priority over all free visits', () => {
  const paidVisit = { id: 'paid-1', visitDate: new Date(2026, 4, 10), importedDetails: { workType: 'Chargeable Service' } };
  const lifecycle = getServiceLifecycle({
    saleDate,
    workshopVisits: [...completedFreeVisits, paidVisit, {
      id: 'newer-free',
      visitDate: new Date(2026, 9, 10),
      importedDetails: { workType: 'Free Service' },
    }],
  }, asOf);

  assert.equal(lifecycle.phase, 'paid');
  assert.equal(lifecycle.referenceDate.getTime(), paidVisit.visitDate.getTime());
});

test('multiple paid visits use the latest dated paid visit and ignore future dates', () => {
  const latestPaid = { visitDate: new Date(2026, 4, 20), importedDetails: { workType: 'Customer Pay' } };
  const lifecycle = getServiceLifecycle({
    saleDate: null,
    workshopVisits: [
      { visitDate: new Date(2025, 4, 20), importedDetails: { workType: 'Paid Service' } },
      latestPaid,
      { visitDate: new Date(2027, 4, 20), importedDetails: { workType: 'Paid Service' } },
    ],
  }, asOf);

  assert.equal(lifecycle.phase, 'paid');
  assert.equal(lifecycle.referenceDate.getTime(), latestPaid.visitDate.getTime());
});

test('a future-dated paid visit does not end free-service eligibility before its visit date', () => {
  const lifecycle = getServiceLifecycle({
    saleDate,
    workshopVisits: [{
      visitDate: new Date(2027, 4, 20),
      importedDetails: { workType: 'Paid Service' },
    }],
  }, asOf);

  assert.equal(lifecycle.phase, 'free');
  assert.equal(lifecycle.referenceDate, null);
});

test('an individual free visit completes only its matching milestone', () => {
  const firstVisit = completedFreeVisits[0];
  const visits = [firstVisit];
  assert.equal(findCompletingVisit(freeServiceDueDate(saleDate, 1), visits, asOf), firstVisit);
  assert.equal(findCompletingVisit(freeServiceDueDate(saleDate, 2), visits, asOf), null);
  assert.equal(findCompletingVisit(freeServiceDueDate(saleDate, 3), visits, asOf), null);
});

test('future free visits do not complete milestones or cause entry into the post-free phase', () => {
  const futureThirdVisit = { visitDate: new Date(2026, 10, 20), importedDetails: { workType: 'Free Service' } };
  const lifecycle = getServiceLifecycle({
    saleDate,
    workshopVisits: [...completedFreeVisits.slice(0, 2), futureThirdVisit],
  }, asOf);
  assert.equal(lifecycle.phase, 'free');
  assert.deepEqual(lifecycle.completedMilestones, [1, 2]);
});

test('paid vehicles and completed milestones do not count as free-service workload', () => {
  const ids = freeServiceCustomerIdsForMonth([
    { customerId: 'paid', saleDate, workshopVisits: [{ visitDate: new Date(2026, 10, 1), importedDetails: { workType: 'Paid Service' } }] },
    { customerId: 'complete', saleDate, workshopVisits: completedFreeVisits },
    { customerId: 'eligible', saleDate: new Date(2026, 8, 10), workshopVisits: [] },
  ], 2026, 10, asOf);

  assert.deepEqual([...ids], ['eligible']);
  assert.equal(countRemainingFreeServiceMilestones({
    saleDate,
    workshopVisits: [{ visitDate: new Date(2026, 10, 1), importedDetails: { workType: 'Paid Service' } }],
  }, asOf), 0);
});
