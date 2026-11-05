// Synthetic, deterministic benchmark data for a LOCAL, EMPTY lakshmi_hyundai_crm_bench database.
//
// Usage (from server/):
//   node scripts/seed-benchmark.mjs [--seed 42] [--ccms 4] [--customers 10000] [--vehicles 12000] [--visits 75000]
//        [--call-list 12000] [--appointments 5000] [--call-logs 50000] [--follow-ups 20000]
//        [--allocations 10000] [--monthly-entries 3000] [--dry-run]
//
// Safety:
//   - the connection comes only from BENCH_SEED_DATABASE_URL in server/.env.bench.seed (never server/.env)
//   - host must be localhost/127.0.0.1 and the database name must be exactly "lakshmi_hyundai_crm_bench"
//   - refuses to run unless the database is completely empty; it never deletes, truncates or resets anything
//   - all people, phone numbers and VINs are fake
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { findCompletingVisit, freeServiceDueDate, FREE_SERVICE_MILESTONES } from '../src/utils/serviceCalendar.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_DB = 'lakshmi_hyundai_crm_bench';
const DAY = 86400000;
const BATCH = 1000;

function fail(message) {
  console.error(`seed: refusing to run - ${message}`);
  process.exit(2);
}

function parseArgs() {
  const options = {
    seed: 42, ccms: 4, customers: 10000, vehicles: 12000, visits: 75000, callList: 12000, appointments: 5000,
    callLogs: 50000, followUps: 20000, allocations: 10000, monthlyEntries: 3000, dryRun: false,
  };
  const names = {
    '--seed': 'seed', '--ccms': 'ccms', '--customers': 'customers', '--vehicles': 'vehicles', '--visits': 'visits',
    '--call-list': 'callList', '--appointments': 'appointments', '--call-logs': 'callLogs',
    '--follow-ups': 'followUps', '--allocations': 'allocations', '--monthly-entries': 'monthlyEntries',
  };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (names[arg]) {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0) fail(`${arg} needs a non-negative integer`);
      options[names[arg]] = value;
    } else fail(`unknown argument ${arg}`);
  }
  if (options.ccms < 1 || options.ccms > 8) fail('--ccms must be 1-8');
  if (options.vehicles < 1 || options.customers < 1 || options.customers > options.vehicles) fail('need 1 <= customers <= vehicles');
  if (options.callList > options.vehicles) fail('--call-list cannot exceed --vehicles (one entry per vehicle)');
  return options;
}

function connectionUrl() {
  const file = path.join(serverDir, '.env.bench.seed');
  if (!existsSync(file)) fail('server/.env.bench.seed is missing (BENCH_SEED_DATABASE_URL for the local bench database)');
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('BENCH_SEED_DATABASE_URL='));
  if (!line) fail('BENCH_SEED_DATABASE_URL is not set in .env.bench.seed');
  const raw = line.slice('BENCH_SEED_DATABASE_URL='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
  let url;
  try { url = new URL(raw); } catch { fail('BENCH_SEED_DATABASE_URL is not a valid URL'); }
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) fail('host must be localhost or 127.0.0.1');
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== ALLOWED_DB) fail(`database name must be exactly ${ALLOWED_DB}`);
  return raw;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const options = parseArgs();
const rand = mulberry32(options.seed);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const weighted = (entries) => {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rand() * total;
  for (const [value, weight] of entries) { roll -= weight; if (roll <= 0) return value; }
  return entries[entries.length - 1][0];
};
const pad = (value, width) => String(value).padStart(width, '0');
const now = new Date();
const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const addDays = (date, days) => new Date(date.getTime() + days * DAY);
const dateOnly = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kavya', 'Anaya', 'Diya', 'Meera', 'Rohan', 'Karthik', 'Priya', 'Suresh', 'Lakshmi', 'Anil', 'Divya', 'Ramesh', 'Sneha', 'Vikram', 'Nisha', 'Arjun'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Nair', 'Patel', 'Kumar', 'Singh', 'Rao', 'Menon', 'Pillai', 'Das', 'Gupta', 'Naidu', 'Chowdhury', 'Verma'];
const MODELS = [['i10 Nios', 'Era'], ['Grand i10 Nios', 'Sportz'], ['Aura', 'S'], ['i20', 'Asta'], ['Venue', 'SX'], ['Verna', 'SX'], ['Creta', 'SX(O)'], ['Alcazar', 'Signature'], ['Exter', 'SX'], ['Tucson', 'Platinum'], ['Ioniq 5', 'Long Range']];
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const REG_STATES = ['TN', 'KA', 'AP', 'TS', 'KL'];
const OUTCOMES = [['CONTACTED', 30], ['CALLBACK', 12], ['NOT_INTERESTED', 8], ['WRONG_NUMBER', 3], ['APPOINTMENT_SET', 12], ['FOLLOW_UP_LATER', 10], ['NO_RESPONSE', 22], ['OTHER', 3]];
const SOURCES = [['SERVICE', 70], ['FREE_SERVICE', 20], ['WARRANTY', 10]];
const APPT_STATUS = [['PENDING', 30], ['CONFIRMED', 35], ['RESCHEDULED', 8], ['CANCELLED', 12], ['NO_SHOW', 15]];
const WORK_TYPES = ['Paid Service', 'Running Repair', 'Accident Repair', 'Periodic Maintenance'];

function vinFor(index) {
  let tail = '';
  let rest = index + 100000;
  for (let position = 0; position < 7; position += 1) { tail = VIN_CHARS[rest % VIN_CHARS.length] + tail; rest = Math.floor(rest / VIN_CHARS.length); }
  return `MALBB51BLN${tail}`.slice(0, 17);
}
const mobileFor = (index) => `9${pad(index % 1000000000, 9)}`.slice(0, 10);

// ---------- build in memory (small relative to 16 GB; only plain objects) ----------
const users = [];
const ccmDefs = [];
const passwordHash = options.dryRun ? 'dry-run' : await bcrypt.hash('Bench#12345', 4);
const addUser = (user) => { users.push({ status: 'active', password: passwordHash, createdAt: addDays(now, -400), ...user }); return user; };

addUser({ id: 'bu_admin', username: 'bench_admin', name: 'Bench Admin', role: 'ADMIN' });
const gmCount = Math.min(2, options.ccms);
for (let g = 1; g <= gmCount; g += 1) addUser({ id: `bu_gm${g}`, username: `bench_gm${g}`, name: `Bench GM ${g}`, role: 'GM' });
for (let c = 1; c <= options.ccms; c += 1) {
  const ccmId = `ccm-bench${pad(c, 2)}`;
  const ccm = { id: `bu_ccm${c}`, ccmId, cres: [], freeCres: [] };
  addUser({ id: ccm.id, username: `bench_ccm${c}`, name: `Bench CCM ${c}`, role: 'CCM', ccmId, gmId: `bu_gm${((c - 1) % gmCount) + 1}` });
  for (let r = 1; r <= 3; r += 1) {
    const id = `bu_ccm${c}_cre${r}`;
    addUser({ id, username: `bench_ccm${c}_cre${r}`, name: `Bench CRE ${c}-${r}`, role: 'CRE', ccmId, freeServiceEnabled: r <= 2, warrantyEnabled: r !== 2 });
    ccm.cres.push(id);
  }
  const freeId = `bu_ccm${c}_fscre`;
  addUser({ id: freeId, username: `bench_ccm${c}_fscre`, name: `Bench Free-Service CRE ${c}`, role: 'FREE_SERVICE_CRE', ccmId });
  ccm.freeCres.push(freeId);
  ccmDefs.push(ccm);
}
const userById = new Map(users.map((user) => [user.id, user]));
const ccmWeights = ccmDefs.map((ccm, index) => [ccm, [30, 25, 20, 15, 10, 8, 6, 4][index]]);

// Physical vehicles and vehicles. A small share of physical vehicles is also owned by a second CCM (same VIN).
const sharedCount = Math.min(Math.round(options.vehicles * 0.03), Math.floor(options.vehicles / 2));
const physicalCount = options.vehicles - sharedCount;
const physicals = [];
const vehicles = [];
const regCounter = new Map();
const nextReg = (ccm) => {
  const count = (regCounter.get(ccm.ccmId) || 0) + 1;
  regCounter.set(ccm.ccmId, count);
  return `${REG_STATES[ccmDefs.indexOf(ccm) % REG_STATES.length]}${pad(int(1, 99), 2)}${pick(['AB', 'CD', 'EF', 'GH', 'JK'])}${pad(count, 4)}`;
};
const makeVehicle = (physical, ccm, customerIndex, saleDate) => {
  const [model, variant] = pick(MODELS);
  const vehicle = {
    id: `bv_${pad(vehicles.length + 1, 6)}`,
    vin: physical.vin,
    physicalVehicleId: physical.id,
    registrationNumber: nextReg(ccm),
    make: 'Hyundai',
    model,
    variant,
    year: saleDate ? saleDate.getFullYear() : null,
    saleDate,
    status: weighted([['ACTIVE', 95], ['INACTIVE', 4], ['ARCHIVED', 1]]),
    customerId: `bc_${pad(customerIndex + 1, 6)}`,
    ccmId: ccm.ccmId,
    ccm,
    createdAt: addDays(now, -int(1, 900)),
  };
  vehicles.push(vehicle);
  return vehicle;
};

for (let p = 0; p < physicalCount; p += 1) {
  physicals.push({ id: `bp_${pad(p + 1, 6)}`, vin: vinFor(p), createdAt: addDays(now, -int(1, 900)) });
  const ccm = weighted(ccmWeights);
  // Sale dates skew recent: ~6 years of history, with a null/invalid tail like real imports.
  const saleDate = rand() < 0.04 ? null : dateOnly(addDays(startOfToday, -Math.floor((rand() ** 1.3) * 2190) - 1));
  makeVehicle(physicals[p], ccm, p < options.customers ? p : int(0, options.customers - 1), saleDate);
}
const sharedPairs = new Set();
for (let s = 0, attempts = 0; s < sharedCount && ccmDefs.length > 1 && attempts < sharedCount * 20; attempts += 1) {
  const source = vehicles[int(0, physicalCount - 1)];
  const other = pick(ccmDefs.filter((ccm) => ccm.ccmId !== source.ccmId));
  const key = `${source.physicalVehicleId}:${other.ccmId}`;
  if (sharedPairs.has(key)) continue;
  sharedPairs.add(key);
  makeVehicle(physicals[Number(source.physicalVehicleId.slice(3)) - 1], other, int(0, options.customers - 1), source.saleDate);
  s += 1;
}
const vehiclesByPhysical = new Map();
for (const vehicle of vehicles) {
  if (!vehiclesByPhysical.has(vehicle.physicalVehicleId)) vehiclesByPhysical.set(vehicle.physicalVehicleId, []);
  vehiclesByPhysical.get(vehicle.physicalVehicleId).push(vehicle);
}

// Customers: ccmId is non-authoritative, so it only records the first vehicle's CCM.
const customerFirstCcm = new Map();
for (const vehicle of vehicles) if (!customerFirstCcm.has(vehicle.customerId)) customerFirstCcm.set(vehicle.customerId, vehicle.ccmId);
const customers = [];
for (let c = 0; c < options.customers; c += 1) {
  const id = `bc_${pad(c + 1, 6)}`;
  customers.push({
    id,
    customerCode: `BENCH-C${pad(c + 1, 6)}`,
    fullName: `Test ${pick(FIRST)} ${pick(LAST)} ${c + 1}`,
    mobileNumber: rand() < 0.97 ? mobileFor(c * 7 + 1) : null,
    alternatePhone: rand() < 0.2 ? mobileFor(c * 7 + 3) : null,
    email: rand() < 0.4 ? `bench.customer${c + 1}@example.invalid` : null,
    city: pick(['Chennai', 'Bengaluru', 'Hyderabad', 'Kochi', 'Coimbatore']),
    pin: String(500000 + int(1, 99999)),
    ccmId: customerFirstCcm.get(id) ?? null,
    createdAt: addDays(now, -int(1, 900)),
  });
}
const customerById = new Map(customers.map((customer) => [customer.id, customer]));

// Workshop visits are shared per physical vehicle; the owning vehicle row (first linked vehicle) carries the visit.
const visits = [];
const roCounter = new Map();
const lapsed = new Set();
const plans = [];
for (const physical of physicals) {
  const owner = vehiclesByPhysical.get(physical.id)[0];
  if (!owner.saleDate) { plans.push({ physical, owner, max: int(0, 3), n: 0 }); continue; }
  const ageDays = Math.max(1, Math.floor((startOfToday - owner.saleDate) / DAY));
  const lapse = rand() < 0.3;
  if (lapse) lapsed.add(physical.id);
  const max = Math.max(1, Math.floor(ageDays / 100));
  plans.push({ physical, owner, ageDays, max, n: 0, lapse });
}
const capacity = plans.reduce((sum, plan) => sum + plan.max, 0);
const targetVisits = Math.min(options.visits, capacity);
let assigned = 0;
const order = plans.map((_, index) => index);
while (assigned < targetVisits) {
  const plan = plans[order[int(0, order.length - 1)]];
  if (plan.n < plan.max) { plan.n += 1; assigned += 1; }
}
for (const plan of plans) {
  const { owner, physical, n } = plan;
  if (!n) continue;
  const spacing = plan.ageDays ? plan.ageDays / (plan.lapse ? Math.max(n + 1, 4) : n + 0.5) : 150;
  for (let k = 0; k < n; k += 1) {
    const base = owner.saleDate ? addDays(owner.saleDate, 45 + Math.round(k * Math.min(spacing, 190)) + int(-20, 20)) : addDays(startOfToday, -int(30, 1500));
    let visitDate = dateOnly(base > startOfToday ? addDays(startOfToday, -int(1, 30)) : base);
    if (rand() < 0.02) visitDate = null;
    const sequence = (roCounter.get(owner.ccmId) || 0) + 1;
    roCounter.set(owner.ccmId, sequence);
    const repairOrderNo = `${owner.ccmId.slice(-2).toUpperCase()}R${pad(sequence, 7)}`;
    const labor = int(300, 9000);
    const parts = int(0, 24000);
    visits.push({
      id: `bw_${pad(visits.length + 1, 6)}`,
      repairOrderNo,
      normalizedRepairOrderNo: repairOrderNo.toUpperCase(),
      customerId: owner.customerId,
      vehicleId: owner.id,
      physicalVehicleId: physical.id,
      ccmId: owner.ccmId,
      totalLaborCost: labor,
      totalPartsCost: parts,
      totalAmount: labor + parts,
      visitDate,
      closingDate: visitDate ? addDays(visitDate, int(0, 3)) : null,
      gpDate: visitDate && rand() < 0.8 ? addDays(visitDate, int(1, 5)) : null,
      importedDetails: { workType: k < 3 && rand() < 0.85 ? 'Free Service' : pick(WORK_TYPES), kms: 1000 + k * 8000 + int(0, 3000) },
      createdAt: visitDate ?? addDays(now, -int(1, 900)),
    });
  }
}

// Milestones for every vehicle with a sale date, completed from matching visits using the app's own rule.
const visitsByPhysical = new Map();
for (const visit of visits) {
  if (!visitsByPhysical.has(visit.physicalVehicleId)) visitsByPhysical.set(visit.physicalVehicleId, []);
  visitsByPhysical.get(visit.physicalVehicleId).push(visit);
}
const milestones = [];
for (const vehicle of vehicles) {
  if (!vehicle.saleDate) continue;
  // Workshop history is shared per physical vehicle, so every CCM-owned vehicle sees all of its visits.
  const own = visitsByPhysical.get(vehicle.physicalVehicleId) || [];
  for (const { milestone } of FREE_SERVICE_MILESTONES) {
    const dueDate = freeServiceDueDate(vehicle.saleDate, milestone);
    const done = findCompletingVisit(dueDate, own);
    milestones.push({
      id: `bm_${pad(milestones.length + 1, 6)}`,
      vehicleId: vehicle.id,
      physicalVehicleId: vehicle.physicalVehicleId,
      milestone,
      dueDate,
      ...(done ? { status: 'completed', completedAt: new Date(done.visitDate), completedByRepairOrderNo: done.repairOrderNo, completedByWorkshopVisitId: done.id } : {}),
    });
  }
}

const creIdsFor = (ccmId) => ccmDefs.find((ccm) => ccm.ccmId === ccmId)?.cres ?? [];
const snapshotOf = (id) => {
  const user = id ? userById.get(id) : null;
  return user ? { id: user.id, name: user.name, username: user.username } : null;
};
const recentDate = (maxDays) => addDays(now, -Math.floor((rand() ** 1.6) * maxDays));

// Master call list: one entry per vehicle for the first N vehicles, assigned within the owning CCM.
const masterEntries = vehicles.slice(0, options.callList).map((vehicle, index) => {
  const customer = customerById.get(vehicle.customerId);
  const assigned = rand() < 0.9 ? pick(creIdsFor(vehicle.ccmId)) : null;
  return {
    id: `bl_${pad(index + 1, 6)}`,
    customerName: customer.fullName,
    mobileNumber: customer.mobileNumber ?? mobileFor(index),
    vin: vehicle.vin,
    registrationNumber: vehicle.registrationNumber,
    ccmId: vehicle.ccmId,
    ownerUserId: assigned,
    vehicleId: vehicle.id,
    assignmentNeedsReview: !assigned && rand() < 0.5,
    status: weighted([['pending', 80], ['completed', 20]]),
    createdAt: vehicle.createdAt,
  };
});

const allocations = [];
for (let a = 0; a < options.allocations; a += 1) {
  const vehicle = vehicles[int(0, vehicles.length - 1)];
  const cre = rand() < 0.92 ? snapshotOf(pick(creIdsFor(vehicle.ccmId))) : null;
  allocations.push({
    id: `ba_${pad(a + 1, 6)}`,
    vehicleId: vehicle.id,
    creId: cre?.id ?? null,
    creIdSnapshot: cre?.id ?? null,
    creNameSnapshot: cre?.name ?? null,
    creUsernameSnapshot: cre?.username ?? null,
    ccmId: vehicle.ccmId,
    serviceType: pick(['Paid Service', 'Free Service', 'Warranty']),
    category: pick(['1Y', '6M', null]),
    status: weighted([['assigned', 85], ['completed', 15]]),
    assignmentNeedsReview: !cre,
    createdAt: recentDate(365),
  });
}

const appointments = [];
for (let a = 0; a < options.appointments; a += 1) {
  const vehicle = vehicles[int(0, vehicles.length - 1)];
  const customer = customerById.get(vehicle.customerId);
  const assignee = snapshotOf(pick(creIdsFor(vehicle.ccmId)));
  appointments.push({
    id: `bp2_${pad(a + 1, 6)}`,
    customerId: customer.id,
    vehicleId: vehicle.id,
    customerName: customer.fullName,
    vehicleName: `${vehicle.make} ${vehicle.model}`,
    scheduledAt: addDays(startOfToday, int(-365, 60) + 0.4),
    status: weighted(APPT_STATUS),
    ccmId: vehicle.ccmId,
    assigneeId: assignee.id,
    createdById: assignee.id,
    assigneeIdSnapshot: assignee.id,
    assigneeNameSnapshot: assignee.name,
    assigneeUsernameSnapshot: assignee.username,
    createdByIdSnapshot: assignee.id,
    createdByNameSnapshot: assignee.name,
    createdByUsernameSnapshot: assignee.username,
    confirmationCall: rand() < 0.4,
    createdAt: recentDate(400),
  });
}

const callLogs = [];
for (let c = 0; c < options.callLogs; c += 1) {
  const vehicle = vehicles[int(0, vehicles.length - 1)];
  const cre = snapshotOf(pick(creIdsFor(vehicle.ccmId)));
  const outcome = weighted(OUTCOMES);
  const createdAt = recentDate(365);
  callLogs.push({
    id: `bg_${pad(c + 1, 6)}`,
    customerId: vehicle.customerId,
    vehicleId: vehicle.id,
    ccmId: vehicle.ccmId,
    assignedToId: cre.id,
    createdById: cre.id,
    assignedToIdSnapshot: cre.id,
    assignedToNameSnapshot: cre.name,
    assignedToUsernameSnapshot: cre.username,
    createdByIdSnapshot: cre.id,
    createdByNameSnapshot: cre.name,
    createdByUsernameSnapshot: cre.username,
    outcome,
    callSource: weighted(SOURCES),
    notes: rand() < 0.3 ? 'Synthetic benchmark note' : null,
    followUpAt: ['CALLBACK', 'FOLLOW_UP_LATER'].includes(outcome) ? addDays(createdAt, int(1, 14)) : null,
    createdAt,
  });
}

const followUps = [];
for (let f = 0; f < options.followUps; f += 1) {
  const vehicle = vehicles[int(0, vehicles.length - 1)];
  const cre = snapshotOf(pick(creIdsFor(vehicle.ccmId)));
  followUps.push({
    id: `bf_${pad(f + 1, 6)}`,
    customerId: vehicle.customerId,
    vehicleId: vehicle.id,
    ccmId: vehicle.ccmId,
    creId: cre.id,
    creIdSnapshot: cre.id,
    creNameSnapshot: cre.name,
    creUsernameSnapshot: cre.username,
    source: weighted(SOURCES),
    followUpAt: addDays(startOfToday, int(-30, 45)),
    category: weighted(OUTCOMES.filter(([name]) => ['CALLBACK', 'FOLLOW_UP_LATER', 'APPOINTMENT_SET', 'CONTACTED'].includes(name))),
    status: weighted([['pending', 65], ['completed', 35]]),
    createdAt: recentDate(120),
  });
}

// Monthly datasets: one per CCM per month for the last 12 months.
const datasets = [];
const monthlyEntries = [];
const perDataset = Math.max(0, Math.floor(options.monthlyEntries / Math.max(1, ccmDefs.length * 12)));
for (const ccm of ccmDefs) {
  for (let back = 0; back < 12; back += 1) {
    const base = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const dataset = { id: `bd_${ccm.id}_${back}`, ccmUserId: ccm.id, ccmUserIdSnapshot: ccm.id, ccmUserNameSnapshot: userById.get(ccm.id).name, ccmUserUsernameSnapshot: userById.get(ccm.id).username, ccmId: ccm.ccmId, year: base.getFullYear(), month: base.getMonth() + 1 };
    datasets.push(dataset);
    const pool = vehicles.filter((vehicle) => vehicle.ccmId === ccm.ccmId);
    for (let e = 0; e < perDataset && pool.length; e += 1) {
      const vehicle = pool[int(0, pool.length - 1)];
      const customer = customerById.get(vehicle.customerId);
      monthlyEntries.push({
        id: `be_${pad(monthlyEntries.length + 1, 6)}`,
        datasetId: dataset.id,
        customerId: customer.id,
        vehicleId: vehicle.id,
        createdById: ccm.id,
        dedupeKey: `${vehicle.vin}:${e}`,
        customerName: customer.fullName,
        mobileNumber: customer.mobileNumber ?? mobileFor(e),
        vin: vehicle.vin,
        registrationNumber: vehicle.registrationNumber,
        make: vehicle.make,
        model: vehicle.model,
        vehicleYear: vehicle.year,
        serviceType: pick(['Paid Service', 'Free Service']),
        source: 'import',
      });
    }
  }
}

const strip = (rows, drop = []) => rows.map(({ ccm, ...row }) => { for (const key of drop) delete row[key]; return row; });
const plan = [
  ['users', 'user', users],
  ['workshopConfiguration', 'workshopConfiguration', [{ id: 'bench_config' }]],
  ['customers', 'customer', customers],
  ['physicalVehicles', 'physicalVehicle', physicals],
  ['vehicles', 'vehicle', strip(vehicles)],
  ['workshopVisits', 'workshopVisit', visits],
  ['freeServiceMilestones', 'freeServiceMilestone', milestones],
  ['masterCallLists', 'masterCallList', masterEntries],
  ['allocations', 'allocation', allocations],
  ['appointments', 'appointment', appointments],
  ['callLogs', 'callLog', callLogs],
  ['followUps', 'followUp', followUps],
  ['monthlyDatasets', 'monthlyCustomerDataset', datasets],
  ['monthlyEntries', 'monthlyCustomerDataEntry', monthlyEntries],
];

console.log(`seed: seed=${options.seed} ccms=${options.ccms} dryRun=${options.dryRun}`);
for (const [label, , rows] of plan) console.log(`  planned ${label.padEnd(24)} ${rows.length}`);
const lapsedShare = Math.round((lapsed.size / physicals.length) * 100);
console.log(`  shared physical vehicles (same VIN in two CCMs): ${vehicles.length - physicals.length}; lapsed-customer share ~${lapsedShare}%`);
if (options.dryRun) { console.log('seed: dry run, nothing was written'); process.exit(0); }

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionUrl() }) });
try {
  const [{ database, host }] = await prisma.$queryRaw`SELECT current_database() AS database, COALESCE(inet_server_addr()::text, 'local') AS host`;
  if (database !== ALLOWED_DB) fail(`connected to ${database}`);
  console.log(`seed: connected to ${database} (${host})`);
  const existing = await Promise.all([prisma.user.count(), prisma.customer.count(), prisma.vehicle.count(), prisma.workshopVisit.count()]);
  if (existing.some((count) => count > 0)) fail('the database is not empty. Nothing was changed; ask the owner before replacing data.');

  for (const [label, model, rows] of plan) {
    const started = Date.now();
    await prisma.$transaction(async (transaction) => {
      for (let offset = 0; offset < rows.length; offset += BATCH) {
        await transaction[model].createMany({ data: rows.slice(offset, offset + BATCH) });
      }
    }, { timeout: 600000, maxWait: 60000 });
    console.log(`  inserted ${label.padEnd(24)} ${String(rows.length).padStart(7)}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  await prisma.$executeRawUnsafe('ANALYZE');
  console.log('seed: done (ANALYZE run)');
} finally {
  await prisma.$disconnect();
}
