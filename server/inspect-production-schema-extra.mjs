import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();

  const checks = await client.query(`
    SELECT
      t.typname AS enum_name,
      e.enumlabel AS enum_value
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname IN ('CallSource', 'UserRole')
    ORDER BY t.typname, e.enumsortorder;
  `);

  console.log("\nRelevant enum values:");
  console.table(checks.rows);

  const constraints = await client.query(`
    SELECT
      conname,
      confdeltype
    FROM pg_constraint
    WHERE conrelid = '"master_call_lists"'::regclass
      AND conname = 'master_call_lists_vin_fkey';
  `);

  console.log("\nVIN foreign key:");
  console.table(constraints.rows);

  const followups = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'follow_ups'
      AND column_name IN ('creId', 'milestoneId', 'source', 'vehicleId')
    ORDER BY column_name;
  `);

  console.log("\nFollow-up columns:");
  console.table(followups.rows);

} finally {
  await client.end();
}
