// Fixture oracle for the Master Call List SQL prototype. Covers the cases the synthetic dataset lacks.
//
// Isolation: NOTHING is written to any database. The OLD path is the real `getCallList` controller with the Prisma
// client's model delegates replaced by an in-memory fake that evaluates the same `where` / `select` objects over
// fixture arrays. The NEW path is the prototype SQL, fed the same arrays as JSON (`options.fixture`) over the
// guarded read-only connection, followed by the real phase-2 record builder over the same fake.
// Any Prisma call that the fake does not implement throws.
//
// Usage (TZ must be set BEFORE node starts): $env:TZ='America/New_York'; node scripts/benchmark/master-call-list-fixtures.mjs
import { configureBenchEnvironment, importApp, openGuardedClient } from './bench-db.mjs';
import { writeFileSync } from 'node:fs';

configureBenchEnvironment();
const realInfo = console.info;
console.info = (...args) => { if (!String(args[0]).startsWith('[call-list-memory]')) realInfo(...args); };
const RealDate = Date;
const { prisma } = await importApp('config/prisma.js');
const records = await importApp('controllers/recordsController.js');
const masterList = await importApp('utils/masterCallList.js');
const { loadMasterCallListPageTwoPhase } = await import('./master-call-list-prototype.mjs');
const client = await openGuardedClient();
const processTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;

// ---------- frozen clock (affects the old path's `new Date()` calls too) ----------
function freezeClock(instant) {
  const frozen = instant.getTime();
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(frozen); else super(...args);
    }
    static now() { return frozen; }
  };
}
const unfreezeClock = () => { globalThis.Date = RealDate; };

// ---------- in-memory Prisma fake ----------
const OPERATORS = new Set(['in', 'not', 'lt', 'lte', 'gt', 'gte', 'equals', 'is', 'some']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !(v instanceof RealDate) && !Array.isArray(v);
const norm = (v) => (v instanceof RealDate ? v.getTime() : v === undefined ? null : v);

function matchField(field, cond) {
  if (cond === null) return field == null;
  if (!isPlainObject(cond)) return norm(field) === norm(cond);
  const keys = Object.keys(cond);
  if (keys.some((k) => OPERATORS.has(k))) {
    return keys.every((k) => {
      const v = cond[k];
      switch (k) {
        case 'in': return v.some((x) => norm(x) === norm(field));
        case 'not': return !matchField(field, v);
        case 'lt': return field != null && norm(field) < norm(v);
        case 'lte': return field != null && norm(field) <= norm(v);
        case 'gt': return field != null && norm(field) > norm(v);
        case 'gte': return field != null && norm(field) >= norm(v);
        case 'equals': return norm(field) === norm(v);
        case 'is': return field != null && evaluate(field, v);
        case 'some': return (field || []).some((item) => evaluate(item, v));
        default: throw new Error(`fake prisma: unsupported operator ${k}`);
      }
    });
  }
  return field != null && evaluate(field, cond);
}

function evaluate(record, where) {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'AND') { if (![].concat(cond).every((w) => evaluate(record, w))) return false; continue; }
    if (key === 'OR') { if (!cond.some((w) => evaluate(record, w))) return false; continue; }
    if (key === 'NOT') { if ([].concat(cond).some((w) => evaluate(record, w))) return false; continue; }
    if (!matchField(record[key], cond)) return false;
  }
  return true;
}

function compareValues(a, b, nullsLast) {
  const x = norm(a); const y = norm(b);
  if (x === null && y === null) return 0;
  if (x === null) return nullsLast ? 1 : -1;
  if (y === null) return nullsLast ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

function sortRows(rows, orderBy) {
  const specs = [].concat(orderBy || []).flatMap((entry) => Object.entries(entry));
  return [...rows].sort((left, right) => {
    for (const [field, spec] of specs) {
      const direction = typeof spec === 'string' ? spec : spec.sort;
      const nullsLast = typeof spec === 'object' && spec.nulls ? spec.nulls === 'last' : direction === 'asc';
      const x = norm(left[field]); const y = norm(right[field]);
      if (x === null || y === null) {
        if (x === y) continue;
        return x === null ? (nullsLast ? 1 : -1) : (nullsLast ? -1 : 1);
      }
      const c = compareValues(x, y, nullsLast);
      if (c) return direction === 'desc' ? -c : c;
    }
    // Prisma leaves ties undefined; the fixtures avoid relying on them except where a tie-break is the point.
    return compareValues(right.id, left.id, false);
  });
}

function project(record, select) {
  if (record == null) return record;
  const out = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) { out[key] = record[key]; continue; }
    const value = record[key];
    if (Array.isArray(value)) {
      let items = value;
      if (spec.where) items = items.filter((item) => evaluate(item, spec.where));
      if (spec.orderBy) items = sortRows(items, spec.orderBy);
      if (spec.take) items = items.slice(0, spec.take);
      out[key] = items.map((item) => project(item, spec.select));
    } else {
      out[key] = project(value, spec.select);
    }
  }
  return out;
}

function reviveDates(row) {
  const copy = { ...row };
  for (const key of ['createdAt', 'visitDate', 'saleDate', 'nextServiceDueDate']) {
    if (typeof copy[key] === 'string') copy[key] = new RealDate(copy[key]);
  }
  return copy;
}

function buildGraph(fixture) {
  const t = (name) => (fixture[name] || []).map((row) => reviveDates(JSON.parse(JSON.stringify(row))));
  const master = t('master'); const vehicles = t('vehicles'); const visits = t('visits');
  const allocations = t('allocations'); const entries = t('entries'); const datasets = t('datasets');
  const users = t('users');
  const datasetById = new Map(datasets.map((d) => [d.id, d]));
  const vehicleObjs = vehicles.map((v) => ({
    ...v,
    get physicalVehicle() { return pvObj(v.physicalVehicleId); },
    get allocations() { return allocations.filter((a) => a.vehicleId === v.id); },
    get masterCallListEntries() { return master.filter((m) => m.vehicleId === v.id); },
    get monthlyDataEntries() {
      return entries.filter((e) => e.vehicleId === v.id).map((e) => ({ ...e, dataset: datasetById.get(e.datasetId) || null }));
    },
    get appointments() { return []; },
    get customer() { return { id: v.customerId, appointments: [] }; },
  }));
  const pvCache = new Map();
  function pvObj(id) {
    if (id == null) return null;
    if (!pvCache.has(id)) {
      pvCache.set(id, {
        id,
        get vehicles() { return vehicleObjs.filter((v) => v.physicalVehicleId === id); },
        get workshopVisits() { return visitObjs.filter((w) => w.physicalVehicleId === id); },
      });
    }
    return pvCache.get(id);
  }
  const visitObjs = visits.map((w) => ({ ...w, get physicalVehicle() { return pvObj(w.physicalVehicleId); } }));
  const vehicleById = new Map(vehicleObjs.map((v) => [v.id, v]));
  const masterObjs = master.map((m) => ({ ...m, get vehicle() { return m.vehicleId ? vehicleById.get(m.vehicleId) || null : null; } }));
  const allocationObjs = allocations.map((a) => ({ ...a, get vehicle() { return vehicleById.get(a.vehicleId) || null; } }));
  return { masterObjs, allocationObjs, users };
}

let graph = null;
const callLog = [];
const fakeDelegate = (name, rowsOf) => ({
  async findMany({ where, orderBy, take, select }) {
    callLog.push(name);
    let rows = rowsOf().filter((row) => evaluate(row, where));
    if (orderBy) rows = sortRows(rows, orderBy);
    if (take) rows = rows.slice(0, take);
    return select ? rows.map((row) => project(row, select)) : rows;
  },
});
const originals = {};
function installFake() {
  for (const [name, factory] of Object.entries({
    masterCallList: () => fakeDelegate('masterCallList', () => graph.masterObjs),
    allocation: () => fakeDelegate('allocation', () => graph.allocationObjs),
    user: () => fakeDelegate('user', () => graph.users),
  })) {
    originals[name] = Object.getOwnPropertyDescriptor(prisma, name);
    Object.defineProperty(prisma, name, { value: factory(), configurable: true, writable: true });
  }
}
function removeFake() {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(prisma, name, descriptor); else delete prisma[name];
  }
}
installFake();
// Anything else on the Prisma client would hit the real database, so refuse it for the whole run.
const blocked = ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe', '$transaction', 'workshopVisit', 'vehicle',
  'physicalVehicle', 'customer', 'appointment'];
for (const name of blocked) {
  Object.defineProperty(prisma, name, {
    configurable: true,
    value: new Proxy(function blockedCall() {}, { get() { throw new Error(`fixture run: unexpected prisma.${name}`); }, apply() { throw new Error(`fixture run: unexpected prisma.${name}`); } }),
  });
}

// ---------- fixture builders ----------
const USERS = [
  { id: 'u_admin', name: 'Admin', role: 'ADMIN', status: 'active', ccmId: null, gmId: null },
  { id: 'u_gm1', name: 'GM One', role: 'GM', status: 'active', ccmId: null, gmId: null },
  { id: 'u_gm2', name: 'GM Two', role: 'GM', status: 'active', ccmId: null, gmId: null },
  { id: 'u_ccmA', name: 'CCM A', role: 'CCM', status: 'active', ccmId: 'ccmA', gmId: 'u_gm1' },
  { id: 'u_ccmB', name: 'CCM B', role: 'CCM', status: 'active', ccmId: 'ccmB', gmId: 'u_gm1' },
  { id: 'u_ccmC', name: 'CCM C (no GM)', role: 'CCM', status: 'active', ccmId: 'ccmC', gmId: null },
  { id: 'u_ccmD', name: 'CCM D (GM two)', role: 'CCM', status: 'active', ccmId: 'ccmD', gmId: 'u_gm2' },
  { id: 'u_ccmE', name: 'CCM E inactive', role: 'CCM', status: 'inactive', ccmId: 'ccmE', gmId: 'u_gm1' },
  { id: 'u_creA1', name: 'CRE A1', role: 'CRE', status: 'active', ccmId: 'ccmA', gmId: null },
  { id: 'u_creA2', name: 'CRE A2', role: 'CRE', status: 'active', ccmId: 'ccmA', gmId: null },
  { id: 'u_creB1', name: 'CRE B1', role: 'CRE', status: 'active', ccmId: 'ccmB', gmId: null },
  { id: 'u_fsc', name: 'Free service', role: 'FREE_SERVICE_CRE', status: 'active', ccmId: 'ccmA', gmId: null },
];
const TEST_USERS = ['u_admin', 'u_gm1', 'u_gm2', 'u_ccmA', 'u_ccmB', 'u_ccmC', 'u_creA1', 'u_creA2', 'u_creB1', 'u_fsc'];
const DATASETS = [
  { id: 'ds_A', ccmId: 'ccmA', year: 2026, month: 1 },
  { id: 'ds_B', ccmId: 'ccmB', year: 2026, month: 1 },
];

class Builder {
  constructor(clock) {
    this.clock = clock;
    this.t = { master: [], vehicles: [], visits: [], allocations: [], entries: [], datasets: DATASETS, users: USERS };
    this.seq = 0;
    this.searches = [];
  }
  local(y, mo, d, h = 12, mi = 0) { return new RealDate(y, mo - 1, d, h, mi, 0, 0); }
  // `n` calendar months before the clock's local date, shifted by `days`, at local hour `h`.
  back(n, days = 0, h = 12, mi = 0) {
    const c = this.clock;
    return new RealDate(c.getFullYear(), c.getMonth() - n, c.getDate() + days, h, mi, 0, 0);
  }
  vehicle({ id, vin, ccm, pv, customer, model = 'Creta', sale = null, reg = null }) {
    this.t.vehicles.push({ id, vin, ccmId: ccm, physicalVehicleId: pv || `pv_${vin}`, customerId: customer || `c_${id}`, model, saleDate: sale, registrationNumber: reg, createdAt: this.clock });
  }
  master({ id, ccm, vin, vehicle = null, owner = null, name = 'Fixture Customer', mobile = '9000000000', reg = null, at, status = 'pending' }) {
    this.t.master.push({ id, ccmId: ccm, vin, vehicleId: vehicle, ownerUserId: owner, customerName: name, mobileNumber: mobile, registrationNumber: reg, createdAt: at, status });
  }
  visit({ id, pv, ccm, date, ro, details = null, vehicle = null, createdAt }) {
    this.t.visits.push({ id, physicalVehicleId: pv, ccmId: ccm, vehicleId: vehicle || `v_${pv}`, customerId: 'c_x', repairOrderNo: ro ?? `RO-${id}`, normalizedRepairOrderNo: String(ro ?? id).toUpperCase(), visitDate: date, importedDetails: details, createdAt: createdAt || this.clock });
  }
  alloc({ id, vehicle, ccm, cre = null, type = 'Paid', status = 'assigned', at }) {
    this.t.allocations.push({ id, vehicleId: vehicle, ccmId: ccm, creId: cre, serviceType: type, status, createdAt: at });
  }
  entry({ id, vehicle, dataset = 'ds_A', type = null, due = null, at }) {
    this.t.entries.push({ id, vehicleId: vehicle, datasetId: dataset, serviceType: type, nextServiceDueDate: due, createdAt: at, customerName: 'x', mobileNumber: '1', dedupeKey: id });
  }
  // One scoped vehicle with a master row, optional visits.
  simple({ key, ccm = 'ccmA', owner = null, at = null, visits = [], sale = null, reg = null, name = 'Fixture Customer', mobile = '9000000000', details = null, pv = null }) {
    const vin = `VIN${key}`;
    const vid = `v_${key}`;
    const pvid = pv || `pv_${key}`;
    this.vehicle({ id: vid, vin, ccm, pv: pvid, sale, reg });
    this.master({ id: `m_${key}`, ccm, vin, vehicle: vid, owner, name, mobile, reg, at: at || this.back(0, -(++this.seq)) });
    visits.forEach((date, index) => this.visit({ id: `w_${key}_${index}`, pv: pvid, ccm, date, details: index === 0 ? details : null, vehicle: vid }));
    return { vin, vid, pvid };
  }
}

const day = (clock, n) => new RealDate(clock.getTime() + n * 86400000);

const FIXTURES = {
  'F1 canonical-duplicates + shared VIN'(b) {
    const c = b.clock;
    b.vehicle({ id: 'vA1', vin: 'VINDUP1', ccm: 'ccmA', pv: 'pvD1' });
    b.vehicle({ id: 'vB1', vin: 'VINDUP1', ccm: 'ccmB', pv: 'pvD1' });
    b.vehicle({ id: 'vA2', vin: 'VINDUP2', ccm: 'ccmA' });
    b.vehicle({ id: 'vA3', vin: 'VINDUP3', ccm: 'ccmA' });
    b.vehicle({ id: 'vA4', vin: 'VINDUP4', ccm: 'ccmA' });
    // owned beats unowned even when the unowned row is older; among owned rows the earliest createdAt wins
    b.master({ id: 'm_a1', ccm: 'ccmA', vin: 'VINDUP1', vehicle: 'vA1', owner: null, at: day(c, -10) });
    b.master({ id: 'm_a2', ccm: 'ccmA', vin: 'VINDUP1', vehicle: 'vA1', owner: 'u_creA1', at: day(c, -5) });
    b.master({ id: 'm_a3', ccm: 'ccmA', vin: 'VINDUP1', vehicle: 'vA1', owner: 'u_creA2', at: day(c, -20) });
    b.master({ id: 'm_c1', ccm: 'ccmB', vin: 'VINDUP1', vehicle: 'vB1', owner: null, at: day(c, -2) });
    // identical createdAt, all unowned: the lowest id wins
    const same = day(c, -3);
    b.master({ id: 'm_b2', ccm: 'ccmA', vin: 'VINDUP2', vehicle: 'vA2', at: same });
    b.master({ id: 'm_b1', ccm: 'ccmA', vin: 'VINDUP2', vehicle: 'vA2', at: same });
    b.master({ id: 'm_b0', ccm: 'ccmA', vin: 'VINDUP2', vehicle: 'vA2', at: same });
    // all owned, different createdAt
    b.master({ id: 'm_d2', ccm: 'ccmA', vin: 'VINDUP3', vehicle: 'vA3', owner: 'u_creA1', at: day(c, -4) });
    b.master({ id: 'm_d1', ccm: 'ccmA', vin: 'VINDUP3', vehicle: 'vA3', owner: 'u_creA1', at: day(c, -8) });
    // identical createdAt, both owned
    b.master({ id: 'm_e2', ccm: 'ccmA', vin: 'VINDUP4', vehicle: 'vA4', owner: 'u_creA2', at: same });
    b.master({ id: 'm_e1', ccm: 'ccmA', vin: 'VINDUP4', vehicle: 'vA4', owner: 'u_creA2', at: same });
    // the owner of the unowned-older row is empty string in the wild? NULLIF(owner,'') is exercised by an empty owner
    b.master({ id: 'm_f1', ccm: 'ccmA', vin: 'VINDUP5', vehicle: null, owner: '', at: day(c, -6) });
    b.master({ id: 'm_f2', ccm: 'ccmA', vin: 'VINDUP5', vehicle: null, owner: 'u_creA1', at: day(c, -1) });
    b.visit({ id: 'w_d1', pv: 'pvD1', ccm: 'ccmA', date: b.back(7, 0), ro: 'RO-D1' });
    b.visit({ id: 'w_d1b', pv: 'pvD1', ccm: 'ccmB', date: b.back(7, 0), ro: 'RO-D1' });
    b.visit({ id: 'w_d2', pv: 'pv_VINDUP2', ccm: 'ccmA', date: b.back(13, 0), ro: 'RO-D2' });
    b.visit({ id: 'w_d3', pv: 'pv_VINDUP3', ccm: 'ccmA', date: b.back(5, 0), ro: 'RO-D3' });
    b.alloc({ id: 'al_d1', vehicle: 'vA1', ccm: 'ccmA', cre: 'u_creA1', at: day(c, -30) });
    b.searches.push('vindup', 'ro-d1', 'm_', 'vindup5');
  },

  'F2 null vehicleId / missing optionals'(b) {
    const c = b.clock;
    b.master({ id: 'm_n1', ccm: 'ccmA', vin: 'VINNULL1', vehicle: null, owner: 'u_creA1', mobile: '9000000001', reg: 'KA01NULL', at: day(c, -1) });
    b.master({ id: 'm_n2', ccm: 'ccmA', vin: 'VINNULL2', vehicle: null, owner: null, mobile: '-', reg: null, at: day(c, -2) });
    b.master({ id: 'm_n3', ccm: 'ccmA', vin: 'VINNULL2', vehicle: null, owner: null, mobile: '9000000003', at: day(c, -3) });
    b.master({ id: 'm_n4', ccm: 'ccmB', vin: 'VINNULL1', vehicle: null, owner: null, mobile: '9000000004', at: day(c, -4) });
    b.vehicle({ id: 'vN5', vin: 'VINNULL5', ccm: 'ccmA', pv: 'pvN5', sale: null, reg: 'KA05VEH' });
    b.master({ id: 'm_n5', ccm: 'ccmA', vin: 'VINNULL5', vehicle: 'vN5', owner: 'u_creA2', mobile: '', reg: null, at: day(c, -5) });
    b.visit({ id: 'w_n5a', pv: 'pvN5', ccm: 'ccmA', date: null, ro: 'RO-NULLDATE', details: { workType: 'Paid Service' }, vehicle: 'vN5' });
    b.master({ id: 'm_n6', ccm: 'ccmA', vin: 'VINNULL6', vehicle: 'vNmissing', owner: null, at: day(c, -6) });
    b.searches.push('vinnull', 'ka01null', 'ka05veh', 'ro-nulldate', '9000000003');
  },

  'F3 future / null visits'(b) {
    const c = b.clock;
    b.simple({ key: 'F301', owner: 'u_creA1', visits: [b.back(-2, 0)] });
    b.simple({ key: 'F302', owner: 'u_creA1', visits: [b.back(12, 0), b.back(-1, 0)] });
    b.simple({ key: 'F303', owner: 'u_creA2', visits: [b.back(6, 0), b.back(-1, 0)] });
    b.simple({ key: 'F304', owner: null, visits: [null] });
    b.simple({ key: 'F305', owner: null, visits: [new RealDate(c.getTime() + 3600000)] });
    b.simple({ key: 'F306', owner: null, visits: [new RealDate(c.getTime() - 1), null, b.back(14, 0)] });
    b.simple({ key: 'F307', owner: null, visits: [new RealDate(c.getTime())] });
    b.simple({ key: 'F308', owner: 'u_creA1', visits: [b.back(11, -20), b.back(30, 0), b.back(-12, 0)] });
    b.simple({ key: 'F309', ccm: 'ccmB', owner: null, visits: [b.back(12, 0)], details: { workType: 'Accident Repair' } });
    b.searches.push('vinf30', 'ro-w_f30');
  },

  'F4 search, roNumber, imported mobile'(b) {
    const ca = (key, extra) => b.simple({ key, ...extra });
    ca('S01', { visits: [b.back(2, 0)], mobile: '', details: { roNumber: 'IMP-RO-77', mobileNumber: '9111111111' } });
    ca('S02', { visits: [b.back(2, 0)], mobile: '—', details: { mobile: '9222222222' } });
    ca('S03', { visits: [b.back(2, 0)], mobile: '   ', details: { mobileNumber: '-', phone: '9333333333' } });
    ca('S04', { visits: [b.back(2, 0)], mobile: '', details: { mobileNumber: 9444444444 } });
    ca('S05', { visits: [b.back(2, 0)], name: 'ÅSA Ärlig', mobile: '9000000005' });
    b.t.visits.at(-1).repairOrderNo = 'RO-UPPER-5';
    ca('S06', { visits: [b.back(2, 0)], mobile: '', details: null });
    ca('S07', { visits: [b.back(2, 0)], mobile: '9555555555', details: { mobileNumber: '', mobile: '9777777777' } });
    ca('S08', { visits: [b.back(2, 0)], mobile: '', details: { mobileNumber: null, mobile: '9666666666' } });
    ca('S09', { visits: [b.back(2, 0)], name: 'A%B Percent', mobile: '9000000009' });
    ca('S10', { visits: [b.back(2, 0)], name: 'C_D Under', mobile: '9000000010' });
    ca('S11', { visits: [b.back(2, 0)], name: "O'Hara \\ Slash", mobile: '9000000011' });
    // older visit carries the mobile, newest visit does not (visits are scanned newest-first)
    const s12 = ca('S12', { visits: [b.back(1, 0), b.back(5, 0)], mobile: '', details: {} });
    b.t.visits.find((v) => v.id === 'w_S12_1').importedDetails = { mobileNumber: '9888888888', roNumber: 'OLD-RO-12' };
    // two visits with different mobiles: newest non-empty wins
    ca('S13', { visits: [b.back(1, 0), b.back(5, 0)], mobile: '', details: { phone: '9100000001' } });
    b.t.visits.find((v) => v.id === 'w_S13_1').importedDetails = { mobileNumber: '9100000002' };
    ca('S14', { visits: [b.back(2, 0)], mobile: '', details: { mobileNumber: true, mobile: '9100000003' } });
    ca('S15', { visits: [b.back(2, 0)], mobile: '', details: { mobileNumber: 0, mobile: '9100000004' } });
    ca('S16', { visits: [b.back(2, 0)], mobile: '', details: { roNumber: 12345 } });
    ca('S17', { visits: [b.back(2, 0)], reg: 'TN09SEARCH', mobile: '9000000017' });
    b.searches.push('9111', 'ro-77', '9222', '9333', '9444', '9555', '9666', '9777', '9888', '9100000', 'åsa', 'ärl', 'ro-upper',
      '%', '_', 'a%b', 'c_d', "'", '\\', 'imp-ro', 'old-ro', '12345', 'tn09', '-', '—', 'true');
  },

  'F5 allocation-queue-only'(b) {
    const c = b.clock;
    const qv = (id, vin, ccm, extra = {}) => b.vehicle({ id, vin, ccm, pv: extra.pv, reg: extra.reg ?? `KA01Q${id.slice(-2)}`, model: extra.model || 'i20' });
    qv('qV1', 'QVIN1', 'ccmA');
    b.alloc({ id: 'al_q1', vehicle: 'qV1', ccm: 'ccmA', type: 'Free Service', at: day(c, -9) });
    qv('qV2', 'QVIN2', 'ccmA');
    b.master({ id: 'm_q2', ccm: 'ccmA', vin: 'QVIN2', vehicle: 'qV2', owner: null, at: day(c, -7) });
    b.alloc({ id: 'al_q2', vehicle: 'qV2', ccm: 'ccmA', type: 'PMS', at: day(c, -8) });
    qv('qV3', 'QVIN3', 'ccmA');
    b.master({ id: 'm_q3', ccm: 'ccmA', vin: 'QVIN3', vehicle: 'qV3', owner: 'u_creA1', at: day(c, -6) });
    b.alloc({ id: 'al_q3', vehicle: 'qV3', ccm: 'ccmA', type: 'Paid', at: day(c, -8) });
    qv('qV4', 'QVIN4', 'ccmB');
    b.alloc({ id: 'al_q4', vehicle: 'qV4', ccm: 'ccmB', type: 'Running Repair', at: day(c, -5) });
    qv('qV5', 'QVIN5', 'ccmA');
    b.alloc({ id: 'al_5b', vehicle: 'qV5', ccm: 'ccmA', type: 'Paid', at: day(c, -4) });
    b.alloc({ id: 'al_5a', vehicle: 'qV5', ccm: 'ccmA', type: 'PMS', at: day(c, -4) });
    qv('qV6', 'QVIN6', 'ccmA');
    b.alloc({ id: 'al_q6', vehicle: 'qV6', ccm: 'ccmA', type: 'Paid', status: 'cancelled', at: day(c, -3) });
    qv('qV7', 'QVIN7', 'ccmA');
    b.alloc({ id: 'al_q7', vehicle: 'qV7', ccm: 'ccmA', cre: 'u_creA1', type: 'Paid', at: day(c, -3) });
    qv('qV8', 'QVIN8', 'ccmA', { pv: 'pvQ8' });
    b.alloc({ id: 'al_q8', vehicle: 'qV8', ccm: 'ccmA', type: 'Free', at: day(c, -2) });
    b.visit({ id: 'w_q8', pv: 'pvQ8', ccm: 'ccmA', date: b.back(12, 0), ro: 'RO-Q8', vehicle: 'qV8' });
    qv('qV9', 'QVIN9', 'ccmA');
    b.alloc({ id: 'al_q9', vehicle: 'qV9', ccm: 'ccmA', type: null, at: day(c, -1) });
    // shared VIN: master only in ccmB, unassigned allocation in ccmA, so ccmA sees a queue-only entry
    qv('qV10a', 'QVIN10', 'ccmA', { pv: 'pvQ10' });
    qv('qV10b', 'QVIN10', 'ccmB', { pv: 'pvQ10' });
    b.master({ id: 'm_q10', ccm: 'ccmB', vin: 'QVIN10', vehicle: 'qV10b', owner: null, at: day(c, -2) });
    b.alloc({ id: 'al_q10', vehicle: 'qV10a', ccm: 'ccmA', type: 'Paid', at: day(c, -2) });
    // queue key that also has an owned master elsewhere in the same CCM under a different vehicle row
    qv('qV11', 'QVIN11', 'ccmA');
    b.alloc({ id: 'al_q11', vehicle: 'qV11', ccm: 'ccmA', type: 'PMS', at: day(c, -2) });
    b.alloc({ id: 'al_q11x', vehicle: 'qV11', ccm: 'ccmA', cre: 'u_creA2', type: 'Paid', at: day(c, -1) });
    // queue entry whose own-CCM master row is owned by another ccm's CRE in ccmC (ignored)
    qv('qV12', 'QVIN12', 'ccmC');
    b.alloc({ id: 'al_q12', vehicle: 'qV12', ccm: 'ccmC', type: 'Paid', at: day(c, -1) });
    b.searches.push('qvin', 'free', 'ka01q', 'pms', 'paid', 'ro-q8');
  },

  'F10 allocation-queue edge cases'(b) {
    const c = b.clock;
    const veh = (id, vin, ccm, extra = {}) => b.vehicle({ id, vin, ccm, pv: extra.pv, reg: extra.reg ?? null, model: extra.model || 'i10' });
    // empty VIN: buildAllocationQueueRecords skips it
    veh('xV1', '', 'ccmA');
    b.alloc({ id: 'alx1', vehicle: 'xV1', ccm: 'ccmA', type: 'Paid', at: day(c, -5) });
    // dangling vehicle reference: no vehicle, skipped
    b.alloc({ id: 'alx2', vehicle: 'vMissing', ccm: 'ccmA', type: 'Paid', at: day(c, -5) });
    // allocation CCM differs from the vehicle's own CCM: the allocation CCM is what counts
    veh('xV3', 'XQVIN3', 'ccmB', { reg: 'KA03X' });
    b.alloc({ id: 'alx3', vehicle: 'xV3', ccm: 'ccmA', type: 'PMS', at: day(c, -4) });
    // unowned master row without a vehicle id in the same CCM suppresses the queue entry (VIN key match)
    veh('xV4', 'XQVIN4', 'ccmA');
    b.master({ id: 'mx4', ccm: 'ccmA', vin: 'XQVIN4', vehicle: null, owner: null, name: 'No Vehicle', at: day(c, -3) });
    b.alloc({ id: 'alx4', vehicle: 'xV4', ccm: 'ccmA', type: 'Free', at: day(c, -3) });
    // VIN differing only in case is a different key
    veh('xV5', 'xqvin5', 'ccmA', { reg: '  ka05 x ' });
    veh('xV5u', 'XQVIN5', 'ccmA');
    b.master({ id: 'mx5', ccm: 'ccmA', vin: 'XQVIN5', vehicle: 'xV5u', owner: null, at: day(c, -2) });
    b.alloc({ id: 'alx5', vehicle: 'xV5', ccm: 'ccmA', type: 'paid', at: day(c, -2) });
    // empty serviceType and lower-case type
    veh('xV6', 'XQVIN6', 'ccmA');
    b.alloc({ id: 'alx6', vehicle: 'xV6', ccm: 'ccmA', type: '', at: day(c, -2) });
    // same VIN queued through two vehicle rows: the lowest allocation id wins
    veh('xV7a', 'XQVIN7', 'ccmA', { reg: 'KA07A' });
    veh('xV7b', 'XQVIN7', 'ccmA', { reg: 'KA07B' });
    b.alloc({ id: 'alx7b', vehicle: 'xV7b', ccm: 'ccmA', type: 'Paid', at: day(c, -9) });
    b.alloc({ id: 'alx7a', vehicle: 'xV7a', ccm: 'ccmA', type: 'PMS', at: day(c, -1) });
    // many queue records with identical (missing) createdAt: ordered by id, spanning page boundaries
    for (let i = 0; i < 8; i += 1) {
      veh(`xP${i}`, `XQPAGE${i}`, 'ccmA');
      b.alloc({ id: `alp${i % 2 ? 'b' : 'a'}${10 - i}`, vehicle: `xP${i}`, ccm: 'ccmA', type: 'Paid', at: day(c, -i) });
    }
    // other CCM isolation, and a CRE-assigned allocation that must not queue
    veh('xV8', 'XQVIN8', 'ccmB');
    b.alloc({ id: 'alx8', vehicle: 'xV8', ccm: 'ccmB', type: 'Paid', at: day(c, -1) });
    veh('xV9', 'XQVIN9', 'ccmA');
    b.alloc({ id: 'alx9', vehicle: 'xV9', ccm: 'ccmA', cre: 'u_creA1', type: 'Paid', at: day(c, -1) });
    b.alloc({ id: 'alx9x', vehicle: 'xV9', ccm: 'ccmA', type: 'Paid', status: 'completed', at: day(c, -1) });
    b.simple({ key: 'X100', owner: null, visits: [b.back(12, 0)] });
    b.searches.push('xqvin', 'ka05', 'ka07', 'xqpage', 'xqvin5');
  },

  'F6 month boundaries / Feb 29 / local midnight / due dates'(b) {
    const c = b.clock;
    let i = 0;
    const add = (label, dates, extra = {}) => b.simple({ key: `F6${String(++i).padStart(2, '0')}`, visits: dates, ...extra });
    for (const n of [5, 6, 7, 11, 12, 13]) {
      add(`${n} same`, [b.back(n, 0)]);
      add(`${n} -1d`, [b.back(n, -1)]);
      add(`${n} +1d`, [b.back(n, 1)]);
      add(`${n} 00:30`, [b.back(n, 0, 0, 30)]);
      add(`${n} 23:30`, [b.back(n, 0, 23, 30)]);
      const base = b.back(n, 0);
      add(`${n} utc midnight`, [new RealDate(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0))]);
      add(`${n} utc 23:30`, [new RealDate(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate(), 23, 30, 0))]);
    }
    add('leap day visit', [b.local(2024, 2, 29)]);
    add('leap day visit utc', [new RealDate(Date.UTC(2024, 1, 29, 0, 0, 0))]);
    add('feb 28 2025', [b.local(2025, 2, 28)]);
    add('mar 1 2025', [b.local(2025, 3, 1)]);
    add('jan 31', [b.local(2026, 1, 31)]);
    add('aug 31 2025', [b.local(2025, 8, 31)]);
    add('feb 29 2028 + later', [b.local(2028, 2, 29), b.local(2027, 12, 1)]);
    add('dec 31 2025 late', [b.local(2025, 12, 31, 23, 59)]);
    add('jan 1 2026 early', [b.local(2026, 1, 1, 0, 0)]);
    // monthly due dates with no visits: around local midnight today
    const start = new RealDate(c.getFullYear(), c.getMonth(), c.getDate());
    for (const [label, due] of [['due start-1ms', new RealDate(start.getTime() - 1)], ['due start', start], ['due start+1ms', new RealDate(start.getTime() + 1)],
      ['due utc midnight today', new RealDate(Date.UTC(c.getFullYear(), c.getMonth(), c.getDate()))],
      ['due utc midnight yesterday', new RealDate(Date.UTC(c.getFullYear(), c.getMonth(), c.getDate() - 1))],
      ['due far future', b.back(-9, 0)], ['due far past', b.back(9, 0)]]) {
      const made = add(label, []);
      b.entry({ id: `e_${made.vid}`, vehicle: made.vid, type: 'Paid', due, at: day(c, -1) });
    }
    // visits-derived due date wins over the monthly one
    const both = add('visit and monthly due', [b.back(12, -2)]);
    b.entry({ id: `e_${both.vid}`, vehicle: both.vid, type: 'PMS', due: b.back(-3, 0), at: day(c, -1) });
    b.searches.push('vinf60', 'vinf61');
  },

  'F7 shared-VIN visibility'(b) {
    const c = b.clock;
    b.vehicle({ id: 'vS_A', vin: 'VINSHARE', ccm: 'ccmA', pv: 'pvS1' });
    b.vehicle({ id: 'vS_B', vin: 'VINSHARE', ccm: 'ccmB', pv: 'pvS1' });
    b.master({ id: 'm_sA', ccm: 'ccmA', vin: 'VINSHARE', vehicle: 'vS_A', owner: 'u_creA1', at: day(c, -3) });
    b.master({ id: 'm_sB', ccm: 'ccmB', vin: 'VINSHARE', vehicle: 'vS_B', owner: null, at: day(c, -2) });
    b.visit({ id: 'w_sA', pv: 'pvS1', ccm: 'ccmA', date: b.back(12, 0), ro: 'RO-SHARED-1', details: { workType: 'Paid Service' }, vehicle: 'vS_A' });
    b.visit({ id: 'w_sB', pv: 'pvS1', ccm: 'ccmB', date: b.back(6, 0), ro: 'RO-SHARED-1', details: { workType: 'Free Service' }, vehicle: 'vS_B' });
    b.visit({ id: 'w_sB2', pv: 'pvS1', ccm: 'ccmB', date: b.back(1, 0), ro: 'RO-B-ONLY', vehicle: 'vS_B' });
    // same physical vehicle, two vehicles in ccmA owned by different CREs
    b.vehicle({ id: 'vS_A2', vin: 'VINSHARE2', ccm: 'ccmA', pv: 'pvS2' });
    b.vehicle({ id: 'vS_C2', vin: 'VINSHARE2', ccm: 'ccmC', pv: 'pvS2' });
    b.master({ id: 'm_s2A', ccm: 'ccmA', vin: 'VINSHARE2', vehicle: 'vS_A2', owner: 'u_creA2', at: day(c, -5) });
    b.master({ id: 'm_s2C', ccm: 'ccmC', vin: 'VINSHARE2', vehicle: 'vS_C2', owner: null, at: day(c, -4) });
    b.visit({ id: 'w_s2', pv: 'pvS2', ccm: 'ccmC', date: b.back(12, 3), ro: 'RO-S2-C', vehicle: 'vS_C2' });
    // CRE assigned only through an allocation, not an owned master row
    b.vehicle({ id: 'vS_A3', vin: 'VINSHARE3', ccm: 'ccmA', pv: 'pvS3' });
    b.master({ id: 'm_s3A', ccm: 'ccmA', vin: 'VINSHARE3', vehicle: 'vS_A3', owner: 'u_creA1', at: day(c, -6) });
    b.alloc({ id: 'al_s3', vehicle: 'vS_A3', ccm: 'ccmA', cre: 'u_creA2', type: 'PMS', at: day(c, -6) });
    b.visit({ id: 'w_s3', pv: 'pvS3', ccm: 'ccmA', date: b.back(6, 0), ro: 'RO-S3', vehicle: 'vS_A3' });
    // monthly entry and allocation belonging to another CCM on a vehicle in ccmA
    b.vehicle({ id: 'vS_A4', vin: 'VINSHARE4', ccm: 'ccmA', pv: 'pvS4' });
    b.master({ id: 'm_s4A', ccm: 'ccmA', vin: 'VINSHARE4', vehicle: 'vS_A4', owner: 'u_creA1', at: day(c, -7) });
    b.entry({ id: 'e_s4', vehicle: 'vS_A4', dataset: 'ds_B', type: 'Running Repair', due: b.back(-2, 0), at: day(c, -2) });
    b.alloc({ id: 'al_s4', vehicle: 'vS_A4', ccm: 'ccmB', cre: 'u_creB1', type: 'Accident Repair', at: day(c, -2) });
    b.searches.push('vinshare', 'ro-shared', 'ro-b-only', 'ro-s2', 'ro-s3');
  },

  'F8 repair-type fallbacks'(b) {
    const c = b.clock;
    let i = 0;
    const mk = (details, { entry = null, alloc = null, dataset = 'ds_A', allocCcm = 'ccmA', allocCre = null, owner = null, visits = true } = {}) => {
      const key = `F8${String(++i).padStart(2, '0')}`;
      const made = b.simple({ key, owner, visits: visits ? [b.back(3, 0)] : [], details });
      if (entry) b.entry({ id: `e_${key}`, vehicle: made.vid, dataset, type: entry.type, due: entry.due || null, at: day(c, -2) });
      if (alloc) b.alloc({ id: `al_${key}`, vehicle: made.vid, ccm: allocCcm, cre: allocCre, type: alloc, at: day(c, -2) });
      return made;
    };
    for (const wt of ['Free Service', 'Free', 'FOC', 'foc check', 'Accident Repair', 'Accidental', 'collision', 'body shop', 'Running Repair', 'running repairs', 'RR',
      'Periodic Maintenance', 'PMS', 'Paid Service', 'chargeable', 'customer-paid', 'cp', 'Others', 'freedom', 'rr1', 'xpms', 'paid_x', 'ünpaid', 'Free_Paid', 'PAID PMS']) {
      mk({ workType: wt });
    }
    mk({ workType: '   ' }, { entry: { type: 'Paid' }, alloc: 'PMS' });
    mk({ workType: '' }, { entry: { type: 'Paid' } });
    mk({ workType: 0 }, { entry: { type: 'Free' } });
    mk({ workType: null }, { alloc: 'Accident Repair' });
    mk({}, { entry: { type: 'Running Repair' }, alloc: 'Paid' });
    mk(null, { entry: { type: null, due: b.back(-1, 0) }, alloc: 'Free Service' });
    mk({ workType: 12 }, { entry: { type: 'Paid' } });
    mk({ workType: true }, { entry: { type: 'Paid' } });
    mk({ workType: ['Paid'] }, { entry: { type: 'Free' } });
    mk({}, { entry: { type: 'Free' }, dataset: 'ds_B' });
    mk({}, { alloc: 'Paid', allocCcm: 'ccmB', allocCre: 'u_creB1' });
    mk({}, { alloc: 'PMS', allocCre: 'u_creA2', owner: 'u_creA1' });
    mk({}, { visits: false, entry: { type: 'Paid' } });
    // latest entry (createdAt desc) with a serviceType wins over an older one; entry with neither is skipped
    const multi = mk({}, {});
    b.entry({ id: 'e_multi_old', vehicle: multi.vid, type: 'Paid', at: day(c, -10) });
    b.entry({ id: 'e_multi_new', vehicle: multi.vid, type: 'Free', at: day(c, -3) });
    b.entry({ id: 'e_multi_empty', vehicle: multi.vid, type: null, due: null, at: day(c, -1) });
    const multiAlloc = mk({}, {});
    b.alloc({ id: 'al_multi_old', vehicle: multiAlloc.vid, ccm: 'ccmA', type: 'Paid', at: day(c, -10) });
    b.alloc({ id: 'al_multi_new', vehicle: multiAlloc.vid, ccm: 'ccmA', type: 'Free', at: day(c, -3) });
    b.alloc({ id: 'al_multi_cancel', vehicle: multiAlloc.vid, ccm: 'ccmA', type: 'PMS', status: 'completed', at: day(c, -1) });
    b.searches.push('vinf8', 'ünpaid');
  },

  'F9 id tie-break collation (informational)'(b) {
    const c = b.clock;
    const same = day(c, -2);
    const ids = ['Zed', 'alpha', 'Beta', 'm-1', 'm_1', 'M1', 'm1', 'a10', 'a2', 'A2', 'é1', 'e2'];
    ids.forEach((id, index) => {
      b.vehicle({ id: `v_${index}`, vin: `VINTIE${index}`, ccm: 'ccmA' });
      b.master({ id, ccm: 'ccmA', vin: `VINTIE${index}`, vehicle: `v_${index}`, owner: null, at: same });
    });
    // canonical tie-break by id inside one group
    b.vehicle({ id: 'v_g', vin: 'VINTIEG', ccm: 'ccmA' });
    for (const id of ['g_Zed', 'g_alpha', 'g_Beta', 'g-1', 'g_1']) b.master({ id, ccm: 'ccmA', vin: 'VINTIEG', vehicle: 'v_g', owner: null, at: same });
    b.searches.push('vintie');
  },
};

// ---------- comparison ----------
const CLOCKS = [
  ['2026-11-04T07:00:00Z', 'ordinary day'],
  ['2028-02-29T06:00:00Z', 'leap day 2028'],
  ['2027-03-31T20:00:00Z', 'month end, local date differs by zone'],
];
const REPAIR_TYPES = ['Free', 'Accidental Repair', 'Running Repair', 'PMS', 'Paid', 'Others'];

function filterMatrix(searches) {
  const base = [{}];
  for (const d of ['6m', '1y', 'allDue', 'pastDue']) base.push({ dueCategory: d });
  for (const r of REPAIR_TYPES) base.push({ repairType: r });
  base.push({ creId: 'unassigned' }, { creId: 'u_creA1' }, { creId: 'u_creA2' }, { creId: 'u_creB1' }, { creId: 'nobody' });
  base.push({ dueCategory: 'pastDue', creId: 'unassigned' }, { dueCategory: '1y', repairType: 'Paid' }, { dueCategory: 'allDue', creId: 'u_creA1' },
    { repairType: 'Free', creId: 'unassigned' });
  for (const s of searches) base.push({ search: s }, { search: s.toUpperCase() });
  if (searches[0]) base.push({ search: searches[0], dueCategory: 'allDue' }, { search: searches[0], repairType: 'Paid' }, { search: searches[0], creId: 'unassigned' });
  return base;
}

function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; } };
}

let nonce = 0;
async function oldPath(user, ccmId, filters, limit) {
  const all = [];
  let offset = 0; let total = null; let first = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const res = fakeRes();
    await records.getCallList({ user, query: { ...filters, ...(ccmId ? { ccmId } : {}), limit: String(limit), offset: String(offset), _nonce: String(++nonce) } }, res);
    if (res.code !== 200) return { status: res.code, message: res.body?.message };
    first ??= res.body;
    total = res.body.total;
    all.push(...res.body.records);
    if (!res.body.hasMore) break;
    offset += limit;
  }
  return { status: 200, total, records: all, first };
}

async function newPath(user, ccmId, filters, limit, clock, options) {
  const all = [];
  let offset = 0; let total = null; let first = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const result = await loadMasterCallListPageTwoPhase({
      app: { records, masterList, prisma }, queryable: client, user, requestedCcmId: ccmId,
      filters: { creId: '', dueCategory: '', repairType: '', ...filters, search: String(filters.search || '').trim().toLocaleLowerCase() },
      pagination: { limit, offset }, now: clock, today: clock, options,
    });
    if (result.error) return { status: 403, message: result.error };
    first ??= result;
    total = result.total;
    all.push(...result.records);
    if (result.missingIds?.length) return { status: 500, message: `missing ids ${result.missingIds}` };
    if (!result.hasMore) break;
    offset += limit;
  }
  return { status: 200, total, records: all, first };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function describeDiff(a, b) {
  if (a.status !== b.status) return `status ${a.status} vs ${b.status}`;
  if (a.status !== 200) return a.message === b.message ? null : `message ${a.message} vs ${b.message}`;
  if (a.total !== b.total || a.records.length !== b.records.length) {
    const idsA = new Set(a.records.map((r) => r.id)); const idsB = new Set(b.records.map((r) => r.id));
    return `total ${a.total} vs ${b.total}; only-old=${JSON.stringify([...idsA].filter((x) => !idsB.has(x)))} only-new=${JSON.stringify([...idsB].filter((x) => !idsA.has(x)))}`;
  }
  const idsA = a.records.map((r) => r.id); const idsB = b.records.map((r) => r.id);
  if (!same(idsA, idsB)) return `ids ${JSON.stringify(idsA)} vs ${JSON.stringify(idsB)}`;
  const queueA = a.records.filter((r) => String(r.id).startsWith('allocation:')).map((r) => r.id);
  const queueB = b.records.filter((r) => String(r.id).startsWith('allocation:')).map((r) => r.id);
  if (!same(queueA, queueB)) return 'queue ids differ';
  for (let i = 0; i < a.records.length; i += 1) {
    if (!same(a.records[i], b.records[i])) {
      const ka = Object.keys(a.records[i]).filter((k) => !same(a.records[i][k], b.records[i][k]));
      return `record ${a.records[i].id} differs in ${ka.join(',')}: ${ka.map((k) => `${JSON.stringify(a.records[i][k])} vs ${JSON.stringify(b.records[i][k])}`).join(' | ')}`;
    }
  }
  const meta = (x) => [x.total, x.limit, x.offset, x.hasMore];
  if (!same(meta(a.first), meta(b.first))) return `first-page meta ${JSON.stringify(meta(a.first))} vs ${JSON.stringify(meta(b.first))}`;
  return null;
}

const VARIANTS = (name) => {
  const out = [{ label: 'lax/C', options: {} }];
  if (name.startsWith('F7') || name.startsWith('F1')) out.push({ label: 'strict/C', options: { strictVisibility: true } });
  if (name.startsWith('F9')) out.push({ label: 'icu', options: { idCollation: 'icu' } }, { label: 'default-collation', options: { idCollation: 'default' } });
  return out;
};

const report = [];
const started = Date.now();
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
for (const [name, build] of Object.entries(FIXTURES)) {
  if (only && !name.startsWith(only)) continue;
  for (const [iso, clockLabel] of CLOCKS) {
    const clock = new RealDate(iso);
    const builder = new Builder(clock);
    build(builder);
    const fixture = builder.t;
    graph = buildGraph(fixture);
    freezeClock(clock);
    try {
      for (const variant of VARIANTS(name)) {
        const entry = { fixture: name, timeZone: processTz, clock: `${iso} (${clockLabel})`, variant: variant.label, comparisons: 0, nonEmpty: 0, queueRecords: 0, mismatches: [] };
        const options = { timeZone: argv.includes('--wrong-tz') ? 'Pacific/Auckland' : processTz, fixture, ...variant.options };
        const matrix = filterMatrix(builder.searches);
        const jobs = [];
        for (const userId of TEST_USERS) {
          const user = USERS.find((u) => u.id === userId);
          for (const filters of matrix) jobs.push({ user, filters, ccmId: '' });
          if (['ADMIN', 'GM'].includes(user.role)) {
            for (const ccmId of ['ccmA', 'ccmB', 'ccmC', 'ccmD', 'ccm-not-real']) jobs.push({ user, filters: {}, ccmId }, { user, filters: { dueCategory: 'allDue' }, ccmId });
          }
        }
        for (const job of jobs) {
          for (const limit of [3, 50]) {
            const left = await oldPath(job.user, job.ccmId, job.filters, limit);
            const right = await newPath(job.user, job.ccmId, job.filters, limit, clock, options);
            entry.comparisons += 1;
            if (left.records?.length) entry.nonEmpty += 1;
            entry.queueRecords += (left.records || []).filter((r) => String(r.id).startsWith('allocation:')).length;
            const diff = describeDiff(left, right);
            if (diff) entry.mismatches.push({ user: job.user.id, ccmId: job.ccmId, filters: job.filters, limit, diff: diff.slice(0, 600) });
          }
        }
        report.push(entry);
        console.log(`${processTz} | ${name} | ${iso} | ${variant.label}: comparisons=${entry.comparisons} nonEmpty=${entry.nonEmpty} queueRecords=${entry.queueRecords} mismatches=${entry.mismatches.length}`);
      }
    } finally {
      unfreezeClock();
    }
  }
}
removeFake();
await client.end();

const totalMismatches = report.reduce((sum, r) => sum + r.mismatches.length, 0);
const summary = { timeZone: processTz, seconds: Math.round((Date.now() - started) / 1000), entries: report.length, comparisons: report.reduce((s, r) => s + r.comparisons, 0), totalMismatches, report: report.map((r) => ({ ...r, mismatches: r.mismatches.slice(0, 8), mismatchCount: r.mismatches.length })) };
if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, report: undefined }, null, 2));
process.exit(0);
