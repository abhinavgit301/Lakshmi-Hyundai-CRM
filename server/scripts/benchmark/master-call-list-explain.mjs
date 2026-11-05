// EXPLAIN (ANALYZE, BUFFERS) for the Phase 1A prototype SQL. Read-only local benchmark database only.
import { writeFileSync } from 'node:fs';
import { configureBenchEnvironment, importApp, openGuardedClient } from './bench-db.mjs';
import { buildMasterCallListPageSql } from './master-call-list-prototype.mjs';

configureBenchEnvironment();
const { prisma } = await importApp('config/prisma.js');
const client = await openGuardedClient();
await client.query("SET statement_timeout = '120s'");
const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'mcl-prototype-explain.txt';

const load = (id) => prisma.user.findFirst({ where: { id }, select: { id: true, role: true, ccmId: true, gmId: true } });
const users = { ADMIN: await load('bu_admin'), GM: await load('bu_gm1'), CCM: await load('bu_ccm1'), CRE: await load('bu_ccm1_cre1') };
const term = (await client.query(`SELECT lower(split_part("customerName", ' ', 1)) AS t FROM master_call_lists WHERE "ccmId"='ccm-bench01' ORDER BY id OFFSET 100 LIMIT 1`)).rows[0].t;
const cases = [];
for (const [role, user] of Object.entries(users)) {
  cases.push([`${role} default`, user, {}], [`${role} dueCategory=1y`, user, { dueCategory: '1y' }], [`${role} search=${term}`, user, { search: term }]);
}
cases.push(['CCM repairType=Paid', users.CCM, { repairType: 'Paid' }], ['ADMIN pastDue', users.ADMIN, { dueCategory: 'pastDue' }]);

const now = new Date();
let output = `# EXPLAIN (ANALYZE, BUFFERS) of the prototype page SQL\n# database=${(await client.query('select current_database() d')).rows[0].d} read_only=${(await client.query("show default_transaction_read_only")).rows[0].default_transaction_read_only} generated=${now.toISOString()}\n\n`;
const summary = [];
for (const [label, user, filters] of cases) {
  const { text, values } = buildMasterCallListPageSql({
    user, filters: { creId: '', dueCategory: '', repairType: '', search: '', ...filters }, pagination: { limit: 50, offset: 0 },
    requestedCcmId: '', now, today: now, options: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF, SETTINGS ON) ${text}`, values);
  const plan = rows.map((r) => r['QUERY PLAN']);
  output += `===== ${label} =====\n${plan.join('\n')}\n\n`;
  const planning = Number(plan.find((l) => l.startsWith('Planning Time'))?.match(/([\d.]+) ms/)?.[1]);
  const execution = Number(plan.find((l) => l.startsWith('Execution Time'))?.match(/([\d.]+) ms/)?.[1]);
  const seq = plan.filter((l) => /Seq Scan/.test(l)).map((l) => l.trim().replace(/\(.*$/, '').trim());
  const idx = plan.filter((l) => /Index (Only )?Scan|Bitmap/.test(l)).length;
  const sorts = plan.filter((l) => /Sort Method/.test(l)).map((l) => l.trim());
  const joins = plan.filter((l) => /(Hash|Nested Loop|Merge) (Left |Semi |Anti )?Join|Nested Loop/.test(l)).length;
  const hit = plan.find((l) => /Buffers: shared/.test(l))?.trim();
  summary.push({ label, planning, execution, seqScans: seq, indexScans: idx, sorts, joins, topBuffers: hit });
}
writeFileSync(outFile, output);
writeFileSync(outFile.replace(/\.txt$/, '-summary.json'), JSON.stringify(summary, null, 2));
for (const s of summary) console.log(`${s.label.padEnd(26)} plan=${s.planning}ms exec=${s.execution}ms seq=${s.seqScans.length} idx=${s.indexScans} sorts=${s.sorts.length} | ${s.topBuffers}`);
await client.end();
process.exit(0);
