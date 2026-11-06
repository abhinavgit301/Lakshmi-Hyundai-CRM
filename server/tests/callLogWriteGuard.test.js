import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(serverRoot, 'src');
const writeMethods = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

test('CallLog writes remain inside aggregate helpers or approved transactional exceptions', async () => {
  const violations = [];
  const sources = await sourceFiles(sourceRoot);
  let approvedUserDeletionWrites = 0;
  for (const file of sources) {
    const relative = path.relative(serverRoot, file).replaceAll('\\', '/');
    const text = await readFile(file, 'utf8');
    const pattern = /\b(?:prisma|transaction|database|tx)\.callLog\.(createMany|updateMany|deleteMany|create|update|upsert|delete)\b/g;
    for (const match of text.matchAll(pattern)) {
      const method = match[1];
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      const allowedCreate = relative === 'src/controllers/callWorkflowController.js'
        && method === 'create'
        && text.includes('await addCallToAggregates(transaction, callLog);');
      const allowedUserDeletion = relative === 'src/controllers/userController.js'
        && method === 'updateMany'
        && match.index >= text.indexOf('async function snapshotDeletedUserReferences')
        && match.index < text.indexOf('\n}', text.indexOf('async function snapshotDeletedUserReferences'))
        && text.includes('noteCreDeleted(transaction, { creId: target.id });');
      if (allowedUserDeletion) approvedUserDeletionWrites += 1;
      const allowedAggregateHelper = relative === 'src/utils/creCallAggregates.js';
      if (!allowedCreate && !allowedUserDeletion && !allowedAggregateHelper) {
        violations.push(`${relative}:${line} CallLog.${method}`);
      }
    }

    if (relative === 'src/services/legacyImportReconciliationService.js') {
      assert.match(text, /await removeCallFromAggregates\(transaction, callLog\);/,
        'legacy CallLog deletion must subtract the old contribution in the same transaction');
    }
    if (relative === 'src/services/importRollbackService.js'
      || relative === 'src/services/permanentImportDeletionService.js') {
      assert.match(text, /noteCreCallEntityScopeChange/,
        `${relative} must re-derive counters when customer or vehicle entities are removed`);
    }
  }
  assert.equal(approvedUserDeletionWrites, 2, 'only the two creator/assignee snapshot writes in user deletion are approved');
  assert.deepEqual(violations, [], `Unapproved CallLog writes:\n${violations.join('\n')}`);
});
