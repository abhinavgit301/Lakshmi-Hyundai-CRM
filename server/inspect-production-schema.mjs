import "dotenv/config";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL
});

try {
  await client.connect();

  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'free_service_milestones',
        'import_batches',
        'import_row_progress',
        'import_change_logs'
      )
    ORDER BY table_name;
  `);

  console.log("\nRelevant tables:");
  console.table(tables.rows);

  const saleDate = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vehicles'
      AND column_name = 'saleDate';
  `);

  console.log("\nvehicles.saleDate exists:", saleDate.rowCount === 1);

  const permissions = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name IN ('freeServiceEnabled', 'warrantyEnabled')
    ORDER BY column_name;
  `);

  console.log("\nUser permission columns:");
  console.table(permissions.rows);

} finally {
  await client.end();
}
