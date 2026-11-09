import { randomBytes, sign, createPrivateKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [outputPath, releaseId, commitSha, runId, runAttempt] = process.argv.slice(2);
const privateKeyPem = process.env.MIGRATION_AUTH_PRIVATE_KEY;
const eventName = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF;
const repository = process.env.GITHUB_REPOSITORY;

if (!outputPath || !/^[0-9a-f]{40}$/.test(releaseId ?? '') ||
    !/^[0-9a-f]{40}$/.test(commitSha ?? '') ||
    !/^[0-9]+$/.test(runId ?? '') || !/^[0-9]+$/.test(runAttempt ?? '') ||
    eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main' ||
    repository !== 'abhinavgit301/Lakshmi-Hyundai-CRM' || !privateKeyPem) {
  throw new Error('Migration authorization can only be created for an approved manual main-branch deployment.');
}

const now = Math.floor(Date.now() / 1000);
const claims = {
  version: 1,
  repository,
  event: eventName,
  ref,
  environment: 'production',
  migrationApproval: true,
  releaseId,
  commitSha,
  runId,
  runAttempt,
  issuedAt: now,
  expiresAt: now + 1800,
  nonce: randomBytes(32).toString('base64url'),
};
const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
const signature = sign(null, Buffer.from(payload), createPrivateKey(privateKeyPem)).toString('base64url');
writeFileSync(outputPath, `${JSON.stringify({ payload, signature })}\n`, { flag: 'wx', mode: 0o600 });
