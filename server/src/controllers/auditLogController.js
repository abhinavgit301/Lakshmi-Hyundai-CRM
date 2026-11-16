import { prisma } from '../config/prisma.js';
import { parsePagination } from '../utils/pagination.js';

export async function listAuditLogs(req, res) {
  const pagination = parsePagination(req.query);
  if (pagination.error) return res.status(400).json({ message: pagination.error });

  const where = {};
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: pagination.offset,
      take: pagination.limit,
      select: {
        id: true,
        userNameSnapshot: true,
        userUsernameSnapshot: true,
        entityType: true,
        entityId: true,
        action: true,
        details: true,
        createdAt: true,
        user: { select: { name: true, username: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return res.json({
    records: rows,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
    hasMore: pagination.offset + rows.length < total,
    entries: rows.map((log) => ({
      id: log.id,
      type: log.entityType,
      actor: log.userNameSnapshot || log.user?.name || log.userUsernameSnapshot || log.user?.username || 'System',
      action: log.action,
      entityId: log.entityId,
      summary: log.details || log.action,
      createdAt: log.createdAt,
    })),
  });
}
