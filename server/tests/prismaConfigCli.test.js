import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaCli = path.join(serverDirectory, "node_modules", "prisma", "build", "index.js");
const runtimeUrl = "postgresql://runtime:runtime@127.0.0.1:5432/crm_test?schema=public";

function runPrisma(args, extraEnv = {}) {
  const env = {
    ...process.env,
    DATABASE_URL: runtimeUrl,
    NODE_ENV: "test",
    ...extraEnv,
  };
  delete env.MIGRATION_DATABASE_URL;
  if (extraEnv.MIGRATION_DATABASE_URL !== undefined) {
    env.MIGRATION_DATABASE_URL = extraEnv.MIGRATION_DATABASE_URL;
  }
  return spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: serverDirectory,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("prisma validate works with DATABASE_URL and no MIGRATION_DATABASE_URL", () => {
  const result = runPrisma(["validate"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("prisma generate works with DATABASE_URL and no MIGRATION_DATABASE_URL", () => {
  const result = runPrisma(["generate"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("prisma migrate status fails closed without MIGRATION_DATABASE_URL", () => {
  const result = runPrisma(["migrate", "status"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /MIGRATION_DATABASE_URL.*required/i);
});

test("prisma migrate deploy fails closed when MIGRATION_DATABASE_URL is empty", () => {
  const result = runPrisma(["migrate", "deploy"], { MIGRATION_DATABASE_URL: "   " });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /MIGRATION_DATABASE_URL.*required/i);
});

test("prisma migrate status does not fall back to DATABASE_URL", () => {
  const result = runPrisma(["migrate", "status"]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Cannot reach database server/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /MIGRATION_DATABASE_URL.*required/i);
});

test("global config flags before migrate status do not bypass migration URL fail-close", () => {
  const result = runPrisma(["--config", "prisma.config.ts", "migrate", "status"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /migration|datasource/i);
});

test("extra deploy flags do not bypass migration URL fail-close", () => {
  const result = runPrisma(["migrate", "deploy", "--schema", "prisma/schema.prisma"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /MIGRATION_DATABASE_URL.*required/i);
});

test("migration help does not require migration credentials", () => {
  const result = runPrisma(["migrate", "deploy", "--help"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
