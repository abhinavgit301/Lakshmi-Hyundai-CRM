// Preload for Phase 1B: forces PostgreSQL session timezone = Etc/UTC on EVERY node-postgres connection
// (the harness's own pg.Client AND Prisma's adapter pool, which both use this pg copy), then verifies it.
//   node --import ./scripts/benchmark/session-tz-preload.mjs scripts/benchmark/master-call-list-parity.mjs ...
import { writeFileSync } from 'node:fs';
import { requirePg } from './bench-db.mjs';

const WANT = process.env.PG_SESSION_TZ || 'Etc/UTC';
const pg = requirePg();
const original = pg.Client.prototype.connect;
const stats = { want: WANT, connections: 0, verified: 0, wrong: 0, observed: {} };

async function enforce(client) {
  stats.connections += 1;
  await client.query(`SET TIME ZONE '${WANT.replace(/'/g, '')}'`);
  const { rows } = await client.query("SELECT current_setting('TimeZone') AS tz");
  stats.observed[rows[0].tz] = (stats.observed[rows[0].tz] || 0) + 1;
  if (rows[0].tz === WANT) stats.verified += 1; else { stats.wrong += 1; throw new Error(`session timezone ${rows[0].tz} != ${WANT}`); }
}

pg.Client.prototype.connect = function patchedConnect(callback) {
  if (typeof callback === 'function') {
    return original.call(this, (error) => {
      if (error) return callback(error);
      enforce(this).then(() => callback(null), (e) => callback(e));
    });
  }
  return original.call(this).then(() => enforce(this));
};

process.on('exit', () => {
  const line = `session-tz: ${JSON.stringify(stats)}`;
  console.log(line);
  if (process.env.PG_SESSION_TZ_REPORT) writeFileSync(process.env.PG_SESSION_TZ_REPORT, JSON.stringify(stats, null, 2));
});
