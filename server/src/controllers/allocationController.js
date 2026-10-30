import { prisma } from '../config/prisma.js';
import { validateAllocationPayload, validateAllocationUpdate } from '../utils/allocationRules.js';
import { clearStaleMasterCallListOwner } from '../utils/allocationAccess.js';
import { lockCcmAllocationTeam } from '../utils/customerAllocation.js';

function roleName(role) {
  const value = String(role || '').toUpperCase();
  if (value === 'ADMIN') return 'Admin';
  if (value === 'GM') return 'GM';
  if (value === 'CCM') return 'CCM';
  if (value === 'FREE_SERVICE_CRE' || value === 'FREE-SERVICE CRE') return 'FREE_SERVICE_CRE';
  return 'CRE';
}

function allocationVisibility(user) {
  const role = roleName(user?.role);
  if (role === 'Admin' || role === 'GM') return {};
  if (role === 'CCM') return { ccmId: user.ccmId || 'no-access' };
  return { creId: user?.id || 'no-access', ccmId: user?.ccmId || 'no-access' };
}

async function findActiveCre(creId, ccmId) {
  return prisma.user.findFirst({
    where: { id: creId, role: 'CRE', status: 'active', ccmId },
    select: { id: true },
  });
}

async function findActiveCcm(ccmId) {
  return prisma.user.findFirst({
    where: { role: 'CCM', status: 'active', ccmId },
    select: { ccmId: true },
  });
}

// Keeps the Master Call List owner in step with the allocated CRE, creating the entry only if it is missing.
async function syncMasterCallListOwner(transaction, vehicle, ccmId, creId) {
  const existing = await transaction.masterCallList.findFirst({ where: { vin: vehicle.vin, ccmId }, select: { id: true } });
  if (existing) {
    await transaction.masterCallList.update({ where: { id: existing.id }, data: { ownerUserId: creId } });
    return;
  }
  if (!vehicle.customer?.mobileNumber) return;
  await transaction.masterCallList.create({
    data: {
      customerName: vehicle.customer.fullName,
      mobileNumber: vehicle.customer.mobileNumber,
      vin: vehicle.vin,
      registrationNumber: vehicle.registrationNumber,
      ccmId,
      ownerUserId: creId,
    },
  });
}

export async function listAllocations(req, res) {
  if (roleName(req.user?.role) === 'FREE_SERVICE_CRE') {
    return res.status(403).json({ message: 'Free-Service CRE accounts cannot access normal allocations.' });
  }
  const allocations = await prisma.allocation.findMany({
    where: allocationVisibility(req.user),
    include: {
      cre: { select: { id: true, name: true } },
      vehicle: {
        include: {
          customer: { select: { id: true, fullName: true, mobileNumber: true } },
        },
      },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  });

  return res.json({ allocations });
}

export async function createAllocation(req, res) {
  const validation = validateAllocationPayload(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const { vehicleId, creId, serviceType, category, notes } = validation.value;
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, vin: true, registrationNumber: true, ccmId: true, customer: { select: { ccmId: true, fullName: true, mobileNumber: true } } },
  });
  if (!vehicle) return res.status(404).json({ message: 'Vehicle not found.' });

  const role = roleName(req.user.role);
  const ccmId = vehicle.ccmId;
  if (!ccmId || !vehicle.customer?.ccmId || vehicle.customer.ccmId !== ccmId) {
    return res.status(409).json({ message: 'Vehicle and customer must have a consistent CCM owner before allocation.' });
  }
  if (req.body?.ccmId && String(req.body.ccmId).trim() !== ccmId) {
    return res.status(400).json({ message: 'CCM must match the vehicle team.' });
  }
  if (!await findActiveCcm(ccmId)) return res.status(400).json({ message: 'CCM assignment is invalid.' });

  const cre = await findActiveCre(creId, ccmId);
  if (!cre) return res.status(400).json({ message: 'CRE must be active and assigned to the vehicle team.' });

  const allocation = await prisma.$transaction(async (transaction) => {
    await lockCcmAllocationTeam(transaction, ccmId);
    const currentVehicle = await transaction.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        id: true,
        vin: true,
        registrationNumber: true,
        ccmId: true,
        customer: { select: { ccmId: true, fullName: true, mobileNumber: true } },
      },
    });
    if (!currentVehicle || currentVehicle.ccmId !== ccmId || currentVehicle.customer?.ccmId !== ccmId) {
      return 'ownership-conflict';
    }
    const activeCre = await transaction.user.findFirst({
      where: { id: creId, role: 'CRE', status: 'active', ccmId },
      select: { id: true },
    });
    if (!activeCre) return null;
    const existing = await transaction.allocation.findFirst({
      where: { vehicleId, serviceType, status: 'assigned' },
    });
    if (existing) return false;

    const created = await transaction.allocation.create({
      data: { vehicleId, creId, serviceType, category, notes, ccmId },
      include: {
        cre: { select: { id: true, name: true } },
        vehicle: { include: { customer: { select: { id: true, fullName: true, mobileNumber: true } } } },
      },
    });
    await syncMasterCallListOwner(transaction, currentVehicle, ccmId, creId);
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'Allocation',
        entityId: created.id,
        action: 'CRE_ASSIGNED',
        details: JSON.stringify({ vehicleId, creId, serviceType, ccmId }),
      },
    });
    return created;
  });
  if (allocation === 'ownership-conflict') {
    return res.status(409).json({ message: 'Vehicle and customer ownership changed before allocation.' });
  }
  if (allocation === null) return res.status(400).json({ message: 'CRE must be active and assigned to the vehicle team.' });
  if (allocation === false) return res.status(409).json({ message: 'This vehicle already has an active allocation for that service type.' });

  return res.status(201).json({ allocation });
}

export async function updateAllocation(req, res) {
  const validation = validateAllocationUpdate(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const existing = await prisma.allocation.findFirst({
    where: { id: req.params.id, ...allocationVisibility(req.user) },
    include: { vehicle: { select: { vin: true, registrationNumber: true, ccmId: true, customer: { select: { ccmId: true, fullName: true, mobileNumber: true } } } } },
  });
  if (!existing) return res.status(404).json({ message: 'Allocation not found.' });
  if (roleName(req.user.role) === 'CRE') return res.status(403).json({ message: 'CRE users cannot change allocations.' });
  const teamId = existing.ccmId;
  if (!teamId || existing.vehicle.ccmId !== teamId || existing.vehicle.customer?.ccmId !== teamId) {
    return res.status(409).json({ message: 'Allocation ownership is inconsistent with its vehicle and customer.' });
  }
  if (roleName(req.user.role) === 'CCM' && req.user.ccmId !== teamId) {
    return res.status(404).json({ message: 'Allocation not found.' });
  }

  const update = validation.value;
  if (roleName(req.user.role) === 'CCM' && update.creId) {
    return res.status(403).json({ message: 'Use the Allocation customer list to reassign customers.' });
  }
  if (update.creId) {
    const cre = await findActiveCre(update.creId, teamId);
    if (!cre) return res.status(400).json({ message: 'CRE must be active and assigned to the vehicle team.' });
  }

  const allocation = await prisma.$transaction(async (transaction) => {
    await lockCcmAllocationTeam(transaction, teamId);
    const current = await transaction.allocation.findFirst({
      where: { id: existing.id, ccmId: teamId },
      include: { vehicle: { select: { vin: true, registrationNumber: true, ccmId: true, customer: { select: { ccmId: true, fullName: true, mobileNumber: true } } } } },
    });
    if (!current || current.vehicle.ccmId !== teamId || current.vehicle.customer?.ccmId !== teamId) return 'ownership-conflict';
    if (update.creId) {
      const activeCre = await transaction.user.findFirst({
        where: { id: update.creId, role: 'CRE', status: 'active', ccmId: teamId },
        select: { id: true },
      });
      if (!activeCre) return null;
    }
    const updated = await transaction.allocation.update({
      where: { id: existing.id },
      data: update,
      include: {
        cre: { select: { id: true, name: true } },
        vehicle: { include: { customer: { select: { id: true, fullName: true, mobileNumber: true } } } },
      },
    });
    if (update.creId) await syncMasterCallListOwner(transaction, current.vehicle, teamId, update.creId);
    else await clearStaleMasterCallListOwner(transaction, { allocation: current, update, ccmId: teamId });
    await transaction.auditLog.create({
      data: {
        userId: req.user.id,
        entityType: 'Allocation',
        entityId: updated.id,
        action: update.creId ? 'CRE_REASSIGNED' : 'ALLOCATION_UPDATED',
        details: JSON.stringify(update),
      },
    });
    return updated;
  });
  if (allocation === 'ownership-conflict') {
    return res.status(409).json({ message: 'Allocation ownership changed before the update.' });
  }
  if (!allocation) return res.status(400).json({ message: 'CRE must be active and assigned to the vehicle team.' });

  return res.json({ allocation });
}