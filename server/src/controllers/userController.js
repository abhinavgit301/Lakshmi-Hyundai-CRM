import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { isValidUsername, normalizeUsername, validateOptionalPhone } from '../utils/userRules.js';
import {
  allocateUnassignedMasterCallListEntries,
  redistributeCreAssignments,
} from '../utils/customerAllocation.js';
import { resolveCreServicePermissions } from '../utils/creServicePermissions.js';

const MANAGED_ROLES = ['GM', 'CCM', 'CRE', 'FREE_SERVICE_CRE'];

function roleFromInput(role) {
  const normalized = String(role || '').trim().toUpperCase();
  return MANAGED_ROLES.includes(normalized) ? normalized : null;
}

async function activeGmExists(gmId) {
  if (!gmId) return false;
  return Boolean(await prisma.user.findFirst({ where: { id: gmId, role: 'GM', status: 'active' }, select: { id: true } }));
}

async function activeCcmExists(ccmId) {
  if (!ccmId) return false;
  return Boolean(await prisma.user.findFirst({
    where: { role: 'CCM', ccmId, status: 'active' },
    select: { id: true },
  }));
}

async function ccmIdIsAvailable(ccmId, exceptUserId) {
  if (!ccmId) return false;
  return !await prisma.user.findFirst({
    where: { role: 'CCM', ccmId, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    select: { id: true },
  });
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username || user.email?.split('@')[0] || '',
    name: user.name,
    phone: user.phone || null,
    role: user.role,
    ccmId: user.ccmId,
    gmId: user.gmId || null,
    dealerCode: user.dealerCode || null,
    freeServiceEnabled: user.freeServiceEnabled === true,
    warrantyEnabled: user.warrantyEnabled === true,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function listUsers(_req, res) {
  const users = await prisma.user.findMany({
    where: { role: { in: MANAGED_ROLES } },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({ users: users.map(sanitizeUser) });
}

export async function createUser(req, res) {
  const { name, username, password, role, phone, dealerCode, gmId, ccmId } = req.body || {};
  for (const field of ['freeServiceEnabled', 'warrantyEnabled']) {
    if (req.body?.[field] !== undefined && typeof req.body[field] !== 'boolean') {
      return res.status(400).json({ message: `${field} must be a boolean.` });
    }
  }

  if (!name || !username || !password) {
    return res.status(400).json({ message: 'Name, username, and password are required.' });
  }

  const normalizedRole = roleFromInput(role);
  if (!normalizedRole) {
    return res.status(400).json({ message: 'Role must be GM, CCM, CRE, or Free-Service CRE.' });
  }

  const cleanName = String(name).trim();
  const normalizedUsername = normalizeUsername(username);
  const phoneResult = validateOptionalPhone(phone);
  if (phoneResult.error) return res.status(400).json({ message: phoneResult.error });
  const cleanCcmId = normalizedRole === 'CCM'
    ? String(ccmId || `ccm-${randomUUID().replaceAll('-', '').slice(0, 8)}`).trim()
    : ['CRE', 'FREE_SERVICE_CRE'].includes(normalizedRole) ? String(ccmId || '').trim() : null;

  if (!cleanName || cleanName.length > 200 || !isValidUsername(normalizedUsername) || String(password).length < 8) {
    return res.status(400).json({ message: 'Name must be valid, username must be 3-40 lowercase letters/numbers/._-, and password must be at least 8 characters.' });
  }

  const duplicateUsername = await prisma.user.findUnique({ where: { username: normalizedUsername }, select: { id: true } });
  if (duplicateUsername) return res.status(409).json({ message: 'This username is already in use.' });

  if (normalizedRole === 'CCM' && !await ccmIdIsAvailable(cleanCcmId)) {
    return res.status(409).json({ message: 'This CCM ID is already assigned.' });
  }

  if (['CRE', 'FREE_SERVICE_CRE'].includes(normalizedRole) && !await activeCcmExists(cleanCcmId)) {
    return res.status(400).json({ message: 'CRE accounts must be assigned to an active CCM.' });
  }

  const cleanGmId = normalizedRole === 'CCM' ? String(gmId || '').trim() : null;
  if (normalizedRole === 'CCM' && !await activeGmExists(cleanGmId)) {
    return res.status(400).json({ message: 'CCM accounts must be assigned to an active GM.' });
  }

  const created = await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.create({
      data: {
        username: normalizedUsername,
        name: cleanName,
        phone: phoneResult.value,
        dealerCode: dealerCode ? String(dealerCode).trim() : null,
        password: await bcrypt.hash(String(password), 10),
        role: normalizedRole,
        ccmId: cleanCcmId || null,
        gmId: cleanGmId,
        freeServiceEnabled: normalizedRole === 'CRE' && req.body?.freeServiceEnabled === true,
        warrantyEnabled: normalizedRole === 'CRE' && req.body?.warrantyEnabled === true,
        status: 'active',
      },
    });
    if (normalizedRole === 'CRE' && cleanCcmId) {
      await allocateUnassignedMasterCallListEntries(transaction, cleanCcmId, req.user.id);
    }
    return user;
  });

  return res.status(201).json({ user: sanitizeUser(created) });
}

export async function getManagedUser(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user || !MANAGED_ROLES.includes(user.role)) {
    return res.status(404).json({ message: 'User not found.' });
  }
  return res.json({ user: sanitizeUser(user) });
}

export async function updateManagedUser(req, res) {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing || !MANAGED_ROLES.includes(existing.role)) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const { name, username, password, role, phone, dealerCode, gmId, ccmId, freeServiceEnabled, warrantyEnabled } = req.body || {};
  const nextRole = role == null ? existing.role : roleFromInput(role);
  if (!nextRole) return res.status(400).json({ message: 'Role must be GM, CCM, CRE, or Free-Service CRE.' });

  const nextName = name == null ? existing.name : String(name).trim();
  const nextUsername = normalizeUsername(username ?? existing.username ?? existing.email?.split('@')[0]);
  const phoneResult = validateOptionalPhone(phone === undefined ? existing.phone : phone);
  if (phoneResult.error) return res.status(400).json({ message: phoneResult.error });
  if (!nextName || nextName.length > 200 || !isValidUsername(nextUsername)) {
    return res.status(400).json({ message: 'Name and username are required and must be valid.' });
  }
  if (password != null && String(password).length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  }
  for (const [field, value] of Object.entries({ freeServiceEnabled, warrantyEnabled })) {
    if (value !== undefined && typeof value !== 'boolean') {
      return res.status(400).json({ message: `${field} must be a boolean.` });
    }
  }

  if (nextUsername !== existing.username) {
    const duplicateUsername = await prisma.user.findUnique({ where: { username: nextUsername }, select: { id: true } });
    if (duplicateUsername && duplicateUsername.id !== existing.id) return res.status(409).json({ message: 'This username is already in use.' });
  }

  if (existing.role === 'CCM' && nextRole !== 'CCM') {
    const [assignedCre, hasCustomers, hasVehicles, hasDatasets] = await Promise.all([
      prisma.user.findFirst({ where: { role: { in: ['CRE', 'FREE_SERVICE_CRE'] }, ccmId: existing.ccmId }, select: { id: true } }),
      prisma.customer.findFirst({ where: { ccmId: existing.ccmId }, select: { id: true } }),
      prisma.vehicle.findFirst({ where: { ccmId: existing.ccmId }, select: { id: true } }),
      prisma.monthlyCustomerDataset.findFirst({ where: { OR: [{ ccmUserId: existing.id }, { ccmId: existing.ccmId }] }, select: { id: true } }),
    ]);
    if (assignedCre || hasCustomers || hasVehicles || hasDatasets) {
      return res.status(409).json({ message: 'Reassign the CCM team data and CRE accounts before changing this role.' });
    }
  }

  if (existing.role === 'CCM' && nextRole === 'CRE' && (ccmId == null || String(ccmId).trim() === existing.ccmId)) {
    return res.status(400).json({ message: 'Choose a different active CCM before changing this CCM account to CRE.' });
  }

  if (existing.role === 'CCM' && nextRole === 'CCM' && ccmId != null && String(ccmId).trim() !== existing.ccmId) {
    return res.status(409).json({ message: 'CCM ID is permanent because it owns customer and monthly history.' });
  }

  if (existing.role === 'CRE' && nextRole !== 'CRE' && nextRole !== 'FREE_SERVICE_CRE') {
    const [assignedAllocation, assignedCustomer] = await Promise.all([
      prisma.allocation.findFirst({ where: { creId: existing.id, status: 'assigned' }, select: { id: true } }),
      prisma.masterCallList.findFirst({ where: { ownerUserId: existing.id }, select: { id: true } }),
    ]);
    if (assignedAllocation || assignedCustomer) {
      return res.status(409).json({ message: 'Reassign this CRE’s customers and active vehicle allocations before changing their role.' });
    }
  }

  if (existing.role === 'CRE' && nextRole === 'CRE' && ccmId != null && String(ccmId).trim() !== existing.ccmId) {
    const [activeAllocation, assignedCustomer] = await Promise.all([
      prisma.allocation.findFirst({ where: { creId: existing.id, status: 'assigned' }, select: { id: true } }),
      prisma.masterCallList.findFirst({ where: { ownerUserId: existing.id }, select: { id: true } }),
    ]);
    if (activeAllocation || assignedCustomer) {
      return res.status(409).json({ message: 'Reassign this CRE’s customers and active vehicle allocations before moving them to another CCM.' });
    }
  }

  let nextCcmId = null;
  let nextGmId = null;
  if (nextRole === 'CCM') {
    nextCcmId = ccmId == null ? existing.ccmId : String(ccmId).trim();
    if (!nextCcmId) nextCcmId = `ccm-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    if (!await ccmIdIsAvailable(nextCcmId, existing.id)) {
      return res.status(409).json({ message: 'This CCM ID is already assigned.' });
    }
    nextGmId = String(gmId ?? existing.gmId ?? '').trim();
    if (!await activeGmExists(nextGmId)) return res.status(400).json({ message: 'CCM accounts must be assigned to an active GM.' });
  } else if (nextRole === 'CRE' || nextRole === 'FREE_SERVICE_CRE') {
    nextCcmId = ccmId == null ? existing.ccmId : String(ccmId).trim();
    if (!await activeCcmExists(nextCcmId)) {
      return res.status(400).json({ message: 'CRE accounts must be assigned to an active CCM.' });
    }
  }

  const updated = await prisma.$transaction(async (transaction) => {
    if (existing.role === 'CRE' && nextRole === 'FREE_SERVICE_CRE' && existing.ccmId) {
      await redistributeCreAssignments(transaction, { ccmId: existing.ccmId, departingCreId: existing.id, actorId: req.user.id });
    }
    if (existing.role === 'FREE_SERVICE_CRE' && nextRole !== 'FREE_SERVICE_CRE' && existing.ccmId) {
      await redistributeCreAssignments(transaction, { ccmId: existing.ccmId, departingCreId: existing.id, actorId: req.user.id });
    }
    const user = await transaction.user.update({
      where: { id: existing.id },
      data: {
      username: nextUsername,
      name: nextName,
      phone: phoneResult.value,
      dealerCode: dealerCode === undefined ? existing.dealerCode : String(dealerCode || '').trim() || null,
      role: nextRole,
      ccmId: nextCcmId,
      gmId: nextGmId,
      ...resolveCreServicePermissions({
        existingRole: existing.role,
        nextRole,
        existingFreeServiceEnabled: existing.freeServiceEnabled,
        existingWarrantyEnabled: existing.warrantyEnabled,
        freeServiceEnabled,
        warrantyEnabled,
      }),
      ...(password ? { password: await bcrypt.hash(String(password), 10) } : {}),
      },
    });
    if (existing.role === 'FREE_SERVICE_CRE' && nextRole === 'CRE' && nextCcmId) {
      await allocateUnassignedMasterCallListEntries(transaction, nextCcmId, req.user.id);
    }
    return user;
  });
  return res.json({ user: sanitizeUser(updated) });
}

export async function updateUserStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body || {};

  const allowedStatuses = ['active', 'inactive'];
  if (!allowedStatuses.includes(String(status || '').toLowerCase())) {
    return res.status(400).json({ message: 'Status must be active or inactive.' });
  }

  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, ccmId: true, status: true } });
  if (!existing || !MANAGED_ROLES.includes(existing.role)) {
    return res.status(404).json({ message: 'User not found.' });
  }
  if (existing.role === 'CCM' && String(status).toLowerCase() === 'inactive') {
    const activeCre = await prisma.user.findFirst({
      where: { role: { in: ['CRE', 'FREE_SERVICE_CRE'] }, ccmId: existing.ccmId, status: 'active' },
      select: { id: true },
    });
    if (activeCre) return res.status(409).json({ message: 'Deactivate or reassign active CRE accounts before deactivating this CCM.' });
  }

  const nextStatus = String(status).toLowerCase();
  const updated = await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.update({ where: { id }, data: { status: nextStatus } });
    if (existing.role === 'CRE' && existing.ccmId && nextStatus === 'active') {
      await allocateUnassignedMasterCallListEntries(transaction, existing.ccmId, req.user.id);
    }
    return user;
  });

  return res.json({ user: sanitizeUser(updated) });
}

export async function assignUserToCcm(req, res) {
  const { id } = req.params;
  const { ccmId } = req.body || {};

  if (!ccmId) {
    return res.status(400).json({ message: 'CCM ID is required.' });
  }

  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, ccmId: true } });
  if (!existing || existing.role !== 'CRE') {
    return res.status(404).json({ message: 'User not found.' });
  }
  if (!await activeCcmExists(String(ccmId).trim())) {
    return res.status(400).json({ message: 'CCM assignment must reference an active CCM.' });
  }
  const [activeAllocation, assignedCustomer] = await Promise.all([
    prisma.allocation.findFirst({ where: { creId: id, status: 'assigned' }, select: { id: true } }),
    prisma.masterCallList.findFirst({ where: { ownerUserId: id }, select: { id: true } }),
  ]);
  if ((activeAllocation || assignedCustomer) && existing.ccmId !== String(ccmId).trim()) {
    return res.status(409).json({ message: 'Reassign active vehicle allocations before moving this CRE to another CCM.' });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { ccmId: String(ccmId).trim() },
  });

  return res.json({ user: sanitizeUser(updated) });
}

export async function deleteManagedUser(req, res) {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing || !MANAGED_ROLES.includes(existing.role)) {
    return res.status(404).json({ message: 'User not found.' });
  }

  if (existing.role === 'CCM') {
    const assignedCre = await prisma.user.findFirst({
      where: { role: { in: ['CRE', 'FREE_SERVICE_CRE'] }, ccmId: existing.ccmId },
      select: { id: true },
    });
    if (assignedCre) return res.status(409).json({ message: 'Reassign or delete this CCM CRE accounts before deleting the CCM.' });
  }

  if (existing.role === 'CRE' || existing.role === 'FREE_SERVICE_CRE') {
    await prisma.$transaction(async (transaction) => {
      if (existing.ccmId) {
        await redistributeCreAssignments(transaction, {
          ccmId: existing.ccmId,
          departingCreId: existing.id,
          actorId: req.user.id,
        });
      }
      await transaction.auditLog.create({
        data: {
          userId: req.user.id,
          entityType: 'User',
          entityId: existing.id,
          action: 'ACCOUNT_DELETED',
          details: JSON.stringify({
            name: existing.name,
            username: existing.username || existing.email?.split('@')[0],
            role: existing.role,
            ccmId: existing.ccmId,
            deleted: true,
          }),
        },
      });
      await transaction.user.delete({ where: { id: existing.id } });
    });
    return res.json({ id: existing.id, deleted: true });
  }

  await prisma.$transaction(async (transaction) => {
    if (existing.role === 'CCM' && existing.ccmId) {
      await transaction.monthlyCustomerDataset.updateMany({
        where: { OR: [{ ccmUserId: existing.id }, { ccmId: existing.ccmId }] },
        data: { ccmId: existing.ccmId, ccmUserId: null },
      });
    }
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'User',
        entityId: existing.id,
        action: 'ACCOUNT_DELETED',
        details: JSON.stringify({ username: existing.username || existing.email?.split('@')[0], role: existing.role }),
      },
    });
    await transaction.user.delete({ where: { id: existing.id } });
  });

  return res.json({ id: existing.id, deleted: true });
}

export async function listTeams(req, res) {
  const role = String(req.user?.role || '').toUpperCase();
  const teamScope = role === 'CCM' ? { ccmId: req.user.ccmId || 'no-access' } : {};
  const ccmWhere = { role: 'CCM', status: 'active', ...teamScope };
  const ccms = await prisma.user.findMany({
    where: ccmWhere,
    select: { id: true, name: true, username: true, ccmId: true, gmId: true, dealerCode: true },
    orderBy: { name: 'asc' },
  });

  const gms = await prisma.user.findMany({
    where: { role: 'GM', status: 'active' },
    select: { id: true, name: true, username: true, dealerCode: true },
    orderBy: { name: 'asc' },
  });

  const cres = await prisma.user.findMany({
    where: { role: 'CRE', status: 'active', ...teamScope },
    select: { id: true, name: true, username: true, ccmId: true, dealerCode: true },
    orderBy: { name: 'asc' },
  });

  const freeServiceCres = await prisma.user.findMany({
    where: { role: 'FREE_SERVICE_CRE', status: 'active', ...teamScope },
    select: { id: true, name: true, username: true, ccmId: true, dealerCode: true },
    orderBy: { name: 'asc' },
  });

  return res.json({ gms, ccms, cres, freeServiceCres });
}
