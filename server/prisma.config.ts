import "dotenv/config";
import { defineConfig } from "prisma/config";
import {
  getPrismaSchemaMutationOperation,
  getSchemaMutationError,
} from "./scripts/guard-prisma-schema-mutation.js";

const schemaMutation = getPrismaSchemaMutationOperation(process.argv);
if (schemaMutation) {
  const error = getSchemaMutationError(schemaMutation);
  if (error) throw new Error(`Refusing Prisma schema mutation: ${error}`);
}

const prismaArgs = process.argv.slice(2);
const migrationSubcommands = new Set([
  "status",
  "deploy",
  "dev",
  "reset",
  "resolve",
  "diff",
]);
const migrateIndex = prismaArgs.indexOf("migrate");
const migrationSubcommandIndex =
  migrateIndex >= 0
    ? prismaArgs.slice(migrateIndex + 1).findIndex((arg) => migrationSubcommands.has(arg))
    : -1;
const requestsHelp =
  prismaArgs.includes("--help") ||
  prismaArgs.includes("-h");
const prismaMigrationOperation =
  migrateIndex >= 0 &&
  migrationSubcommandIndex >= 0 &&
  !requestsHelp;

let migrationDatasourceUrl: string | undefined;
if (prismaMigrationOperation) {
  migrationDatasourceUrl = process.env["MIGRATION_DATABASE_URL"]?.trim();
  if (!migrationDatasourceUrl) {
    throw new Error("MIGRATION_DATABASE_URL is required for Prisma migration operations.");
  }
}

const schemaMutationDatasourceUrl = schemaMutation
  ? process.env["DATABASE_URL"]?.trim()
  : undefined;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(migrationDatasourceUrl || schemaMutationDatasourceUrl
    ? {
        datasource: {
          url: migrationDatasourceUrl || schemaMutationDatasourceUrl!,
        },
      }
    : {}),
});
