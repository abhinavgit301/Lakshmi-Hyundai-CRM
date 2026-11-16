import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/config/prisma.js';
import { listAuditLogs } from '../src/controllers/auditLogController.js';

function mockResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('audit log returns paginated database entries and uses saved actor snapshots', async () => {
  const originalFindMany = prisma.auditLog.findMany;
  const originalCount = prisma.auditLog.count;
  const calls = [];
  prisma.auditLog.findMany = async (args) => {
    calls.push(args);
    return [{
      id: 'audit-real-1',
      userNameSnapshot: 'Saved Actor',
      userUsernameSnapshot: 'saved.actor',
      entityType: 'Customer',
      entityId: 'customer-1',
      action: 'updated',
      details: 'Customer updated',
      createdAt: new Date('2026-11-16T08:00:00.000Z'),
      user: null,
    }];
  };
  prisma.auditLog.count = async () => 3;
  try {
    const response = mockResponse();
    await listAuditLogs({ query: { limit: '1', offset: '1' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls[0].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    assert.equal(calls[0].skip, 1);
    assert.equal(calls[0].take, 1);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.hasMore, true);
    assert.equal(response.body.entries[0].actor, 'Saved Actor');
    assert.equal(response.body.entries[0].summary, 'Customer updated');
  } finally {
    prisma.auditLog.findMany = originalFindMany;
    prisma.auditLog.count = originalCount;
  }
});

test('audit log rejects invalid pagination before querying the database', async () => {
  const originalFindMany = prisma.auditLog.findMany;
  let queried = false;
  prisma.auditLog.findMany = async () => { queried = true; return []; };
  try {
    const response = mockResponse();
    await listAuditLogs({ query: { limit: '1000' } }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(queried, false);
  } finally {
    prisma.auditLog.findMany = originalFindMany;
  }
});
