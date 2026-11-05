// SQL page selection for GET /call-list (behind MASTER_CALL_LIST_SQL_ENABLED). Phase 1 of the two-phase design:
// one parameterised SQL statement that applies visibility scope, canonical (ccmId, vin) selection, the existing
// filters/search, the total, and the ordered page of ids. Phase 2 (recordsController.loadCallListPageResponseSql)
// hands those ids to the EXISTING record builder so every displayed field is produced by the existing code.
//
// The JavaScript implementation in recordsController.js / masterCallList.js / masterCallListFilters.js /
// serviceDue.js / repairTypes.js is the source of truth; every SQL fragment below cites the JS it mirrors.
// The Phase 1A parity and fixture harnesses (scripts/benchmark) exercise this exact module.
//
// Safety: this module only builds SELECT text. User-supplied values (search, creId, ccmId, user ids, dates)
// are ONLY passed as bind parameters. Interpolated fragments are constants chosen from validated enums.

import { canonicalWorkshopTimezone, getWorkshopTimezone } from './workshopTime.js';

// The SQL $tz defaults to the shared workshop timezone (the same value the startup guard requires of the process).
// Callers may still pass options.timeZone explicitly; the timezone parity harnesses rely on that.
const EPOCH = "'1970-01-01 00:00:00'::timestamp";

const ID_COLLATIONS = {
  C: 'COLLATE "C"',
  icu: 'COLLATE "und-x-icu"',
  default: '',
};

const TABLES = {
  master: 'master_call_lists',
  vehicles: 'vehicles',
  visits: 'workshop_visits',
  allocations: 'allocations',
  entries: 'monthly_customer_data_entries',
  datasets: 'monthly_customer_datasets',
  users: 'users',
};

// Fixture mode: the same SQL runs against rows supplied as JSON (typed with the real table row types) instead of
// the real tables, so edge cases that the synthetic dataset lacks can be tested without touching any database.
const FIXTURE_TABLE_NAMES = {
  master: 'master_call_lists',
  vehicles: 'vehicles',
  visits: 'workshop_visits',
  allocations: 'allocations',
  entries: 'monthly_customer_data_entries',
  datasets: 'monthly_customer_datasets',
  users: 'users',
};

const upper = (role) => String(role || '').toUpperCase();

// recordsController.usableMobileNumber: String(value ?? '').trim(), rejecting '', '-' and the em dash.
const jsTrim = (expr) => `regexp_replace(${expr}, '^\\s+|\\s+$', '', 'g')`;
const usableText = (expr) => `(CASE WHEN ${jsTrim(expr)} IN ('', '-', '—') THEN NULL ELSE ${jsTrim(expr)} END)`;

// JS `value || fallback` truthiness for a JSON scalar, returned as the text String(value) would produce.
function jsTruthyText(json, key) {
  const node = `(${json}->'${key}')`;
  return `(CASE jsonb_typeof(${node})
    WHEN 'string' THEN NULLIF(${json}->>'${key}', '')
    WHEN 'number' THEN (CASE WHEN ${node}::text::numeric = 0 THEN NULL ELSE ${json}->>'${key}' END)
    WHEN 'boolean' THEN (CASE WHEN ${json}->>'${key}' = 'true' THEN 'true' END)
    WHEN 'object' THEN '[object Object]'
    WHEN 'array' THEN COALESCE((SELECT string_agg(CASE jsonb_typeof(item.value) WHEN 'null' THEN '' WHEN 'string' THEN item.value #>> '{}'
      WHEN 'object' THEN '[object Object]' ELSE item.value::text END, ',' ORDER BY item.ord)
      FROM jsonb_array_elements(${node}) WITH ORDINALITY AS item(value, ord)), '')
  END)`;
}

// repairTypes.classifyMasterRepairType. JS \b only treats [A-Za-z0-9_] as word characters, so it is reproduced
// with explicit look-around instead of Postgres \y (which is locale/Unicode aware).
const WB_L = '(?<![A-Za-z0-9_])';
const WB_R = '(?![A-Za-z0-9_])';
const repairTypeClass = (textExpr) => `(CASE
    WHEN ${textExpr} ~ '${WB_L}(free|foc)${WB_R}' THEN 'Free'
    WHEN ${textExpr} ~ '${WB_L}(accident|accidental|collision|body shop)${WB_R}' THEN 'Accidental Repair'
    WHEN ${textExpr} ~ '${WB_L}(running repair|running repairs|rr)${WB_R}' THEN 'Running Repair'
    WHEN ${textExpr} ~ '${WB_L}(pms|periodic)${WB_R}' THEN 'PMS'
    WHEN ${textExpr} ~ '${WB_L}(paid|chargeable|customer pay|customer-paid|cp)${WB_R}' THEN 'Paid'
    ELSE 'Others' END)`;

function normaliseOptions(options = {}) {
  const idCollation = options.idCollation || 'C';
  if (!(idCollation in ID_COLLATIONS)) throw new Error(`unknown idCollation ${idCollation}`);
  return {
    timeZone: options.timeZone || canonicalWorkshopTimezone(),
    idCollation,
    // Re-applies workshopVisitVisibilityWhere inside SQL. Off = rely on the FK argument that a scoped row's own
    // vehicle always satisfies that predicate; the parity harness runs both settings.
    strictVisibility: options.strictVisibility === true,
    fixture: options.fixture || null,
  };
}

export function buildMasterCallListPageSql({
  user,
  filters = {},
  pagination = { limit: 50, offset: 0 },
  requestedCcmId = '',
  now = new Date(),
  today = new Date(),
  options = {},
}) {
  const opts = normaliseOptions(options);
  const role = upper(user?.role);
  const values = [];
  const bind = (value, cast = 'text') => {
    values.push(value);
    return `$${values.length}::${cast}`;
  };
  const collate = ID_COLLATIONS[opts.idCollation];
  const T = opts.fixture ? FIXTURE_TABLE_NAMES : TABLES;

  // Bound on first use so no parameter is ever supplied without being referenced (Postgres rejects that).
  const lazyBind = (value, cast = 'text') => {
    let token = null;
    return { toString() { token ??= bind(value, cast); return token; } };
  };
  const ccmId = user?.ccmId || 'no-access';
  const userId = user?.id || 'no-access';
  const ccmParam = lazyBind(ccmId);
  const userParam = lazyBind(userId);
  const tzParam = lazyBind(opts.timeZone);
  const nowParam = lazyBind(now.toISOString(), 'timestamptz');
  const todayParam = lazyBind(today.toISOString(), 'timestamptz');

  const fixtureCtes = [];
  if (opts.fixture) {
    for (const [key, name] of Object.entries(FIXTURE_TABLE_NAMES)) {
      const json = bind(JSON.stringify(opts.fixture[key] || []), 'jsonb');
      fixtureCtes.push(
        `${name} AS NOT MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::public.${TABLES[key]}, ${json}))`,
      );
    }
  }

  const { creId = '', dueCategory = '', repairType = '', search = '' } = filters;
  const wantsDue = dueCategory === '6m' || dueCategory === '1y' || dueCategory === 'allDue';
  const wantsPastDue = dueCategory === 'pastDue';
  const needVisits = wantsDue || wantsPastDue || Boolean(repairType) || Boolean(search);
  const needMonthly = wantsPastDue || Boolean(repairType);
  const needAllocation = Boolean(repairType);

  // --- scope: resolveMasterCallListVisibility / getVisibilityWhere --------------------------------------------
  const requested = requestedCcmId ? bind(requestedCcmId) : null;
  const gmAllowed = `SELECT u."ccmId" FROM ${T.users} u WHERE u.role = 'CCM' AND u.status = 'active'
      AND (u."gmId" = ${userParam} OR u."gmId" IS NULL) AND u."ccmId" IS NOT NULL`;
  let scopeSql;
  let forbiddenSql = 'false';
  if (role === 'ADMIN') {
    scopeSql = requested ? `m."ccmId" = ${requested}` : 'true';
  } else if (role === 'GM') {
    scopeSql = `m."ccmId" IN (${gmAllowed})${requested ? ` AND m."ccmId" = ${requested}` : ''}`;
    if (requested) forbiddenSql = `${requested} NOT IN (${gmAllowed})`;
  } else if (role === 'CCM') {
    scopeSql = `m."ccmId" = ${ccmParam}`;
  } else if (role === 'CRE') {
    scopeSql = `m."ccmId" = ${ccmParam} AND m."ownerUserId" = ${userParam}`;
  } else {
    scopeSql = 'false';
  }

  // --- visit visibility: creAccess.workshopVisitVisibilityWhere ------------------------------------------------
  let strictVisitSql = 'true';
  if (opts.strictVisibility && role === 'CCM') {
    strictVisitSql = `EXISTS (SELECT 1 FROM ${T.vehicles} x WHERE x."physicalVehicleId" = v."physicalVehicleId" AND x."ccmId" = ${ccmParam})`;
  } else if (opts.strictVisibility && role === 'CRE') {
    strictVisitSql = `EXISTS (SELECT 1 FROM ${T.vehicles} x WHERE x."physicalVehicleId" = v."physicalVehicleId" AND x."ccmId" = ${ccmParam}
      AND (EXISTS (SELECT 1 FROM ${T.allocations} xa WHERE xa."vehicleId" = x.id AND xa."creId" = ${userParam} AND xa."ccmId" = ${ccmParam} AND xa.status = 'assigned')
        OR EXISTS (SELECT 1 FROM ${T.master} xm WHERE xm."vehicleId" = x.id AND xm."ccmId" = x."ccmId" AND xm."ownerUserId" = ${userParam} AND xm."ccmId" = ${ccmParam})))`;
  } else if (opts.strictVisibility && role !== 'ADMIN' && role !== 'GM') {
    strictVisitSql = 'false';
  }

  const visitOrder = 'w."visitDate" DESC NULLS LAST, w."createdAt" DESC, w.id DESC';
  const mobileKeys = ['mobileNumber', 'mobile', 'mobileNo', 'phoneNumber', 'phone'];
  const importedMobile = `COALESCE(${mobileKeys.map((key) => usableText(`(w."importedDetails"->>'${key}')`)).join(', ')})`;
  const searchParam = search ? bind(search) : null;
  const hit = (expr) => `strpos(lower(COALESCE(${expr}, '')), ${searchParam}) > 0`;

  const visitSelects = [
    'max(w."visitDate") AS max_visit',
    `max(w."visitDate") FILTER (WHERE w."visitDate" <= (${nowParam} AT TIME ZONE 'UTC')) AS last_service`,
  ];
  if (repairType) visitSelects.push(`(array_agg(${jsTruthyText('w."importedDetails"', 'workType')} ORDER BY ${visitOrder}))[1] AS first_work_type`);
  if (search) {
    visitSelects.push(`(array_agg(${importedMobile} ORDER BY ${visitOrder}) FILTER (WHERE ${importedMobile} IS NOT NULL))[1] AS imported_mobile`);
    visitSelects.push(`bool_or(${hit('w."repairOrderNo"')} OR ${hit(jsTruthyText('w."importedDetails"', 'roNumber'))}) AS ro_hit`);
  }

  const datasetCcm = role === 'CCM' || role === 'CRE' ? ` AND d."ccmId" = ${ccmParam}` : '';
  const allocationScope = role === 'CRE'
    ? ` AND a."ccmId" = ${ccmParam} AND a."creId" = ${userParam}`
    : role === 'CCM' ? ` AND a."ccmId" = ${ccmParam}` : '';

  const local = (utcExpr) => `((${utcExpr} AT TIME ZONE 'UTC') AT TIME ZONE ${tzParam})`;
  const nowLocal = `(${nowParam} AT TIME ZONE ${tzParam})`;
  const todayStartUtc = `((date_trunc('day', ${todayParam} AT TIME ZONE ${tzParam}) AT TIME ZONE ${tzParam}) AT TIME ZONE 'UTC')`;

  // serviceDue.classifyServiceDue(getLatestServiceDate(...)) - calendar-month difference in the process-local zone.
  const dueCategorySql = `(CASE
      (EXTRACT(YEAR FROM ${nowLocal}) - EXTRACT(YEAR FROM ${local('vis.last_service')})) * 12
      + (EXTRACT(MONTH FROM ${nowLocal}) - EXTRACT(MONTH FROM ${local('vis.last_service')}))
      WHEN 12 THEN '1y' WHEN 6 THEN '6m' END)`;
  // serviceDue.getYearlyDueDate: local-midnight of the same calendar day one year after the latest visit;
  // new Date(y + 1, 1, 29) overflows to 1 March, reproduced by month-start + (day - 1).
  const maxLocal = local('vis.max_visit');
  const visitDueUtc = `(((make_date(EXTRACT(YEAR FROM ${maxLocal})::int + 1, EXTRACT(MONTH FROM ${maxLocal})::int, 1)
      + (EXTRACT(DAY FROM ${maxLocal})::int - 1))::timestamp AT TIME ZONE ${tzParam}) AT TIME ZONE 'UTC')`;
  const dueUtcSql = `(CASE WHEN vis.max_visit IS NOT NULL THEN ${visitDueUtc} ELSE ${needMonthly ? 'mon."nextServiceDueDate"' : 'NULL::timestamp'} END)`;
  const typeText = `lower(COALESCE(${[
    repairType ? 'vis.first_work_type' : null,
    needMonthly ? `NULLIF(mon."serviceType", '')` : null,
    needAllocation ? `NULLIF(al."serviceType", '')` : null,
    "''",
  ].filter(Boolean).join(', ')}))`;

  // --- filters: masterCallListFilters.filterMasterCallListRecords ---------------------------------------------
  const filterRole = role === 'CCM' || role === 'ADMIN' || role === 'GM';
  const masterConditions = [];
  const queueConditions = [];
  if (filterRole && creId) {
    if (creId === 'unassigned') {
      masterConditions.push(`NULLIF(e.owner, '') IS NULL`);
    } else {
      masterConditions.push(`e.owner = ${bind(creId)}`);
      queueConditions.push('false');
    }
  }
  if (wantsPastDue) { masterConditions.push(`e.due_utc < ${todayStartUtc}`); queueConditions.push('false'); }
  if (dueCategory === 'allDue') { masterConditions.push('e.due_category IS NOT NULL'); queueConditions.push('false'); }
  if (dueCategory === '6m' || dueCategory === '1y') { masterConditions.push(`e.due_category = ${bind(dueCategory)}`); queueConditions.push('false'); }
  if (repairType) {
    const repairParam = bind(repairType);
    masterConditions.push(`e.type_class = ${repairParam}`);
    // allocation-queue records carry the raw allocation serviceType, not a classified type.
    queueConditions.push(`q.type_raw = ${repairParam}`);
  }
  if (search) {
    masterConditions.push(`(${hit('e.customer_name')} OR ${hit('e.mobile_eff')} OR ${hit('e.vin')} OR ${hit('e.reg_eff')} OR COALESCE(e.ro_hit, false))`);
    queueConditions.push(`(${hit('q.vin')} OR ${hit('q.reg')})`);
  }
  const masterWhere = masterConditions.length ? `WHERE ${masterConditions.join(' AND ')}` : '';
  const queueWhere = queueConditions.length ? `AND ${queueConditions.join(' AND ')}` : '';

  const visitLateral = needVisits
    ? `LEFT JOIN LATERAL (SELECT ${visitSelects.join(', ')} FROM ${T.visits} w
         WHERE w."physicalVehicleId" = v."physicalVehicleId" AND ${strictVisitSql}) vis ON true`
    : '';
  // Latest monthly entry / allocation per vehicle are computed once as DISTINCT ON sets and hash-joined. A per-row
  // LATERAL ... LIMIT 1 was measured at ~58 s for 12,000 rows because neither table has a vehicleId index.
  const monthlyCte = needMonthly
    ? `latest_entry AS (
         SELECT DISTINCT ON (en."vehicleId") en."vehicleId", en."serviceType", en."nextServiceDueDate"
         FROM ${T.entries} en JOIN ${T.datasets} d ON d.id = en."datasetId"
         WHERE en."vehicleId" IN (SELECT "vehicleId" FROM canonical WHERE "vehicleId" IS NOT NULL)
           AND (en."serviceType" IS NOT NULL OR en."nextServiceDueDate" IS NOT NULL)${datasetCcm}
         ORDER BY en."vehicleId", en."createdAt" DESC, en.id DESC)`
    : '';
  const allocationCte = needAllocation
    ? `latest_allocation AS (
         SELECT DISTINCT ON (a."vehicleId") a."vehicleId", a."serviceType"
         FROM ${T.allocations} a
         WHERE a."vehicleId" IN (SELECT "vehicleId" FROM canonical WHERE "vehicleId" IS NOT NULL)
           AND a.status = 'assigned'${allocationScope}
         ORDER BY a."vehicleId", a."createdAt" DESC, a.id DESC)`
    : '';
  const monthlyLateral = needMonthly ? 'LEFT JOIN latest_entry mon ON mon."vehicleId" = v.id' : '';
  const allocationLateral = needAllocation ? 'LEFT JOIN latest_allocation al ON al."vehicleId" = v.id' : '';

  const enrichedColumns = [
    'c.id', 'c."createdAt" AS created_at', 'c."ownerUserId" AS owner', 'c."customerName" AS customer_name', 'c.vin',
    wantsDue ? `${dueCategorySql} AS due_category` : 'NULL::text AS due_category',
    wantsPastDue ? `${dueUtcSql} AS due_utc` : 'NULL::timestamp AS due_utc',
    repairType ? `${repairTypeClass(typeText)} AS type_class` : 'NULL::text AS type_class',
    search ? `COALESCE(${usableText('c."mobileNumber"')}, vis.imported_mobile) AS mobile_eff` : 'NULL::text AS mobile_eff',
    search ? `COALESCE(NULLIF(c."registrationNumber", ''), NULLIF(v."registrationNumber", '')) AS reg_eff` : 'NULL::text AS reg_eff',
    search ? 'vis.ro_hit AS ro_hit' : 'NULL::boolean AS ro_hit',
  ];

  // --- allocation queue: recordsController.loadCallListPageResponse + masterCallList.buildAllocationQueueRecords
  const queueSql = role === 'CCM'
    ? `queue AS (
        SELECT DISTINCT ON (a."ccmId", v.vin)
          'allocation:' || a.id AS id, v.vin, NULLIF(v."registrationNumber", '') AS reg, NULLIF(a."serviceType", '') AS type_raw
        FROM ${T.allocations} a
        JOIN ${T.vehicles} v ON v.id = a."vehicleId"
        WHERE a."ccmId" = ${ccmParam} AND a.status = 'assigned' AND a."creId" IS NULL AND NULLIF(v.vin, '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM scoped s WHERE s."ccmId" = a."ccmId" AND s.vin = v.vin)
        ORDER BY a."ccmId", v.vin, a.id ${collate}
      ), queue_filtered AS (SELECT * FROM queue q WHERE true ${queueWhere})`
    : '';
  const queueUnion = role === 'CCM'
    ? `UNION ALL SELECT id, ${EPOCH} AS sort_ts, true AS is_queue FROM queue_filtered`
    : '';

  const limit = bind(String(pagination.limit), 'bigint');
  const offset = bind(String(pagination.offset), 'bigint');

  const text = `WITH ${[
    ...fixtureCtes,
    `scoped AS (SELECT m.* FROM ${T.master} m WHERE ${scopeSql})`,
    // masterCallList.addCanonicalMasterCallListEntry / compareCanonicalEntries: owned first, oldest, then id.
    `canonical AS (
       SELECT DISTINCT ON (m."ccmId", m.vin) m.*
       FROM scoped m
       ORDER BY m."ccmId", m.vin, (NULLIF(m."ownerUserId", '') IS NULL), COALESCE(m."createdAt", ${EPOCH}) ASC, m.id ${collate} ASC
     )`,
    monthlyCte,
    allocationCte,
    `enriched AS (
       SELECT ${enrichedColumns.join(', ')}
       FROM canonical c
       LEFT JOIN ${T.vehicles} v ON v.id = c."vehicleId" AND v."ccmId" = c."ccmId"
       ${visitLateral}
       ${monthlyLateral}
       ${allocationLateral}
     )`,
    `matching AS (SELECT e.id, COALESCE(e.created_at, ${EPOCH}) AS sort_ts, false AS is_queue FROM enriched e ${masterWhere})`,
    queueSql,
    `final AS (SELECT id, sort_ts, is_queue FROM matching ${queueUnion})`,
    `page AS (SELECT id, is_queue, row_number() OVER (ORDER BY sort_ts DESC, id ${collate} ASC) AS rn
       FROM final ORDER BY sort_ts DESC, id ${collate} ASC LIMIT ${limit} OFFSET ${offset})`,
  ].filter(Boolean).join(',\n')}
  SELECT (SELECT count(*) FROM final)::int AS total, ${forbiddenSql} AS forbidden, page.id, page.is_queue
  FROM (SELECT 1) one LEFT JOIN page ON true
  ORDER BY page.rn`;

  return compactParameters(text, values);
}

// Binding helpers may bind a value whose SQL fragment is not emitted for this filter combination; Postgres rejects
// parameters that are supplied but never referenced, so renumber to exactly the referenced set.
function compactParameters(text, values) {
  const mapping = new Map();
  const compactValues = [];
  const rewritten = text.replace(/\$(\d+)/g, (_match, index) => {
    if (!mapping.has(index)) {
      compactValues.push(values[Number(index) - 1]);
      mapping.set(index, compactValues.length);
    }
    return `$${mapping.get(index)}`;
  });
  return { text: rewritten, values: compactValues };
}

export async function runMasterCallListPage(queryable, params) {
  const resolved = await withPostgresTimeZone(params, (text, values) => queryable.query(text, values).then((result) => result.rows));
  const { text, values } = buildMasterCallListPageSql(resolved);
  const { rows } = await queryable.query(text, values);
  return summarisePageRows(rows);
}

// Node canonicalises Asia/Kolkata to the legacy alias Asia/Calcutta, which newer PostgreSQL/tzdata builds (for example
// the Debian-based postgres:18.6 image) no longer recognise. The SQL therefore receives whichever equivalent identifier
// the database accepts: the configured WORKSHOP_TIMEZONE first, then its canonical form. The startup guard has
// already proven both equal the process timezone, so the result is identical. Fails loudly if neither is known.
let resolvedPostgresTimeZone = null;
export function resetPostgresTimeZoneCache() { resolvedPostgresTimeZone = null; }

async function withPostgresTimeZone(params, runQuery) {
  if (params.options?.timeZone) return params;
  if (!resolvedPostgresTimeZone) {
    const candidates = [...new Set([getWorkshopTimezone(), canonicalWorkshopTimezone()])];
    const rows = await runQuery('SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])', [candidates]);
    const known = new Set(rows.map((row) => row.name));
    const match = candidates.find((name) => known.has(name));
    if (!match) {
      throw new Error(`PostgreSQL does not recognise the workshop timezone (tried ${candidates.join(', ')}).`);
    }
    resolvedPostgresTimeZone = match;
  }
  return { ...params, options: { ...params.options, timeZone: resolvedPostgresTimeZone } };
}

function summarisePageRows(rows) {
  const first = rows[0] || { total: 0, forbidden: false };
  return {
    forbidden: first.forbidden === true,
    total: Number(first.total),
    ids: rows.filter((row) => row.id).map((row) => row.id),
    queueIds: rows.filter((row) => row.id && row.is_queue).map((row) => row.id),
  };
}

// Runs the page statement through Prisma's pg adapter. Every user-supplied value is a bind parameter.
export async function runMasterCallListPagePrisma(prismaClient, params) {
  const resolved = await withPostgresTimeZone(params, (text, values) => prismaClient.$queryRawUnsafe(text, ...values));
  // Ordering must match JS localeCompare, so the app path always uses ICU and never falls back to "C".
  const { text, values } = buildMasterCallListPageSql({ ...resolved, options: { ...resolved.options, idCollation: 'icu' } });
  const rows = await prismaClient.$queryRawUnsafe(text, ...values);
  return summarisePageRows(rows);
}

// Only the exact strings 'true' and '1' enable the SQL path; unset or anything else leaves it OFF.
export function isMasterCallListSqlEnabled(env = process.env) {
  const value = String(env.MASTER_CALL_LIST_SQL_ENABLED ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}
