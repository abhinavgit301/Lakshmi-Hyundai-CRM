import { prisma } from '../config/prisma.js';

const OUTCOMES = ['CONTACTED', 'CALLBACK', 'NOT_INTERESTED', 'WRONG_NUMBER', 'APPOINTMENT_SET', 'FOLLOW_UP_LATER', 'NO_RESPONSE', 'OTHER'];

function percent(part, whole) {
  return whole ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

export async function queryWorkshopReportsData({ year, month, tzOffset = 0, ccmId = '', creId = '' }, database = prisma) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100 || !Number.isFinite(tzOffset)) {
    return null;
  }

  // Month boundaries in the viewer's local time.
  const monthStart = new Date(Date.UTC(year, month - 1, 1) + tzOffset * 60000);
  const monthEnd = new Date(Date.UTC(year, month, 1) + tzOffset * 60000);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const [users, archivedUsers] = await Promise.all([
    database.user.findMany({
    where: { role: { in: ['CCM', 'CRE'] }, ccmId: { not: null } },
    select: { id: true, name: true, role: true, ccmId: true },
    orderBy: { name: 'asc' },
    }),
    database.deletedUserIdentity.findMany({
      where: { role: 'CRE', ccmId: { not: null } },
      select: { id: true, name: true, role: true, ccmId: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const reportUsers = [
    ...users,
    ...archivedUsers.map((user) => ({ ...user, archived: true })),
  ];

  let scopeUsers = reportUsers;
  let scope = { type: 'all', id: null, name: 'All teams' };
  if (creId) {
    const cre = reportUsers.find((user) => user.id === creId && user.role === 'CRE' && (!ccmId || user.ccmId === ccmId));
    if (!cre) return { error: ccmId ? 'CRE is not assigned to the selected CCM.' : 'CRE not found.' };
    scopeUsers = [cre];
    scope = { type: 'cre', id: cre.id, name: cre.name };
  } else if (ccmId) {
    scopeUsers = reportUsers.filter((user) => user.ccmId === ccmId);
    if (!scopeUsers.length) return { error: 'Team not found.' };
    const ccm = scopeUsers.find((user) => user.role === 'CCM');
    scope = { type: 'ccm', id: ccmId, name: ccm?.name || 'Team' };
  }

  const userIds = scopeUsers.map((user) => user.id);
  const [calls, appointments, assigned] = await Promise.all([
    database.callLog.findMany({
      where: {
        OR: [{ createdById: { in: userIds } }, { createdByIdSnapshot: { in: userIds } }],
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      select: { createdById: true, createdByIdSnapshot: true, customerId: true, outcome: true, createdAt: true },
    }),
    database.appointment.findMany({
      where: {
        OR: [{ createdById: { in: userIds } }, { createdByIdSnapshot: { in: userIds } }],
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      select: { createdById: true, createdByIdSnapshot: true, createdAt: true },
    }),
    database.masterCallList.groupBy({
      by: ['ownerUserId'],
      where: { ownerUserId: { in: userIds } },
      _count: { _all: true },
    }),
  ]);

  const dayKey = (date) => new Date(date.getTime() - tzOffset * 60000).toISOString().slice(0, 10);
  const daily = Array.from({ length: daysInMonth }, (_, index) => ({
    date: `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
    calls: 0,
    appointments: 0,
  }));
  const dailyByDate = new Map(daily.map((entry) => [entry.date, entry]));
  calls.forEach((call) => { const entry = dailyByDate.get(dayKey(call.createdAt)); if (entry) entry.calls += 1; });
  appointments.forEach((appointment) => { const entry = dailyByDate.get(dayKey(appointment.createdAt)); if (entry) entry.appointments += 1; });

  const outcomeCounts = new Map(OUTCOMES.map((outcome) => [outcome, 0]));
  calls.forEach((call) => outcomeCounts.set(call.outcome, (outcomeCounts.get(call.outcome) || 0) + 1));

  const assignedByUser = new Map(assigned.map((row) => [row.ownerUserId, row._count._all]));

  function summarize(members) {
    const ids = new Set(members.map((member) => member.id));
    const memberCalls = calls.filter((call) => ids.has(call.createdById || call.createdByIdSnapshot));
    const reached = new Set(memberCalls.map((call) => call.customerId)).size;
    const assignedCount = members.reduce((sum, member) => sum + (assignedByUser.get(member.id) || 0), 0);
    return {
      calls: memberCalls.length,
      customersReached: reached,
      appointmentsSet: memberCalls.filter((call) => call.outcome === 'APPOINTMENT_SET').length,
      appointmentsBooked: appointments.filter((appointment) => ids.has(appointment.createdById || appointment.createdByIdSnapshot)).length,
      assignedRecords: assignedCount,
      reachPercent: percent(reached, assignedCount),
    };
  }

  const totals = summarize(scopeUsers);
  totals.conversionPercent = percent(totals.appointmentsBooked, totals.calls);

  let breakdown;
  if (scope.type === 'all') {
    const teamIds = [...new Set(scopeUsers.map((user) => user.ccmId))];
    breakdown = teamIds.map((id) => {
      const members = scopeUsers.filter((user) => user.ccmId === id);
      return { id, name: members.find((user) => user.role === 'CCM')?.name || id, kind: 'Team', ...summarize(members) };
    });
  } else if (scope.type === 'ccm') {
    breakdown = scopeUsers.map((user) => ({ id: user.id, name: user.name, kind: user.role, ...summarize([user]) }));
  } else {
    breakdown = [];
  }

  return {
    scope,
    period: { year, month },
    totals,
    daily,
    outcomes: [...outcomeCounts].map(([outcome, count]) => ({ outcome, count })).filter((entry) => entry.count > 0),
    breakdown,
  };
}

export async function getWorkshopPerformance(req, res) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const tzOffset = Number(req.query.tzOffset || 0);
  const ccmId = req.query.ccmId ? String(req.query.ccmId) : '';
  const creId = req.query.creId ? String(req.query.creId) : '';

  const data = await queryWorkshopReportsData({ year, month, tzOffset, ccmId, creId });
  if (!data) return res.status(400).json({ message: 'A valid year and month are required.' });
  if (data.error) return res.status(404).json({ message: data.error });

  return res.json(data);
}
