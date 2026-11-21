"use strict";

const pg = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();

  try {
    const identity = await prisma.$queryRawUnsafe(`
      SELECT session_user::text AS session_user, current_user::text AS current_user,
             current_database()::text AS database, inet_server_addr()::text AS server_address,
             inet_server_port() AS server_port, r.rolsuper, r.rolinherit, r.rolbypassrls,
             r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolcanlogin,
             (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS membership_count
      FROM pg_roles r WHERE r.rolname = session_user
    `);
    const row = identity[0];
    const url = new URL(process.env.DATABASE_URL);
    if (identity.length !== 1 || row.session_user !== "runtime_login" ||
        row.current_user !== "runtime_login" || row.database !== "lakshmi_hyundai_crm" ||
        row.server_address?.split("/")[0] !== url.hostname ||
        Number(row.server_port) !== Number(url.port || 5432) ||
        row.rolsuper !== false || row.rolinherit !== false || row.rolbypassrls !== false ||
        row.rolcreaterole !== false || row.rolcreatedb !== false || row.rolreplication !== false ||
        row.rolcanlogin !== true || row.membership_count !== 0) {
      throw new Error("Runtime database identity or role attributes do not match the isolated design.");
    }
    console.log(`RUNTIME_IDENTITY=${JSON.stringify(row)}`);

    const denied = [
      ["CREATE_TABLE", "CREATE TABLE public.rehearsal_forbidden(id integer)"],
      ["ALTER_TABLE", 'ALTER TABLE public."_prisma_migrations" ADD COLUMN forbidden text'],
      ["DROP_TABLE", 'DROP TABLE public."_prisma_migrations"'],
      ["CREATE_ROLE", "CREATE ROLE rehearsal_forbidden_role LOGIN"],
      ["CREATE_DATABASE", "CREATE DATABASE rehearsal_forbidden_database"],
      ["SET_ROLE", "SET ROLE migration_login"],
      ["MIGRATION_HISTORY_UPDATE", 'UPDATE public."_prisma_migrations" SET checksum = checksum'],
    ];

    for (const [label, sql] of denied) {
      try {
        await pool.query(sql);
      } catch (error) {
        if (error.code !== "42501") throw error;
        console.log(`${label}=PASS permission denied`);
        continue;
      }
      throw new Error(`${label} unexpectedly succeeded.`);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
