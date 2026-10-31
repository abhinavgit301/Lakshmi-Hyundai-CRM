import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { validateCustomerPayload } from '../utils/customerRules.js';
import { findOrCreatePhysicalVehicle } from '../utils/physicalVehicle.js';
import { normalizeVin } from '../utils/roleAccess.js';

function normalizedRole(role) {
  return String(role || '').toUpperCase();
}

export async function createCustomer(req, res) {
  const validation = validateCustomerPayload(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const role = normalizedRole(req.user?.role);
  const requestedCcmId = req.body?.ccmId ? String(req.body.ccmId).trim() : null;
  if (!['ADMIN', 'GM', 'CCM'].includes(role)) {
    return res.status(403).json({ message: 'You are not permitted to create customers.' });
  }
  if (role === 'CCM' && requestedCcmId && requestedCcmId !== req.user.ccmId) {
    return res.status(403).json({ message: 'CCM users may only create customers for their authenticated CCM.' });
  }
  const ccmId = role === 'CCM' ? String(req.user.ccmId || '').trim() : requestedCcmId;

  if (!ccmId) {
    return res.status(400).json({ message: 'Select an active CCM assignment.' });
  }

  const { fullName, mobileNumber, alternatePhone, email, vehicles } = validation.value;
  const vehicleCcmIds = [...new Set(vehicles.map((vehicle) => {
    if (role === 'CCM' && vehicle.ccmId && vehicle.ccmId !== ccmId) return null;
    return role === 'CCM' ? ccmId : vehicle.ccmId || ccmId;
  }))];
  if (vehicleCcmIds.includes(null)) {
    return res.status(403).json({ message: 'CCM users may only create vehicles for their authenticated CCM.' });
  }
  const activeCcms = await prisma.user.findMany({
    where: { role: 'CCM', ccmId: { in: [...new Set([ccmId, ...vehicleCcmIds])] }, status: 'active' },
    select: { ccmId: true },
  });
  const activeCcmIds = new Set(activeCcms.map(({ ccmId: activeId }) => activeId));
  if (!activeCcmIds.has(ccmId) || vehicleCcmIds.some((vehicleCcmId) => !activeCcmIds.has(vehicleCcmId))) {
    return res.status(400).json({ message: 'CCM assignment is invalid.' });
  }

  try {
    const customer = await prisma.$transaction(async (transaction) => {
      const createdCustomer = await transaction.customer.create({
        data: {
          customerCode: `CUS-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
          fullName,
          mobileNumber,
          alternatePhone,
          email,
          ccmId,
        },
      });
      for (const vehicle of vehicles) {
        const vehicleCcmId = role === 'CCM' ? ccmId : vehicle.ccmId || ccmId;
        const physicalVehicle = await findOrCreatePhysicalVehicle(transaction, vehicle.vin);
        await transaction.vehicle.create({
          data: {
            ...vehicle,
            vin: normalizeVin(vehicle.vin),
            physicalVehicleId: physicalVehicle.id,
            ccmId: vehicleCcmId,
            customerId: createdCustomer.id,
          },
        });
      }
      return transaction.customer.findUniqueOrThrow({
        where: { id: createdCustomer.id },
        include: { vehicles: true },
      });
    });

    return res.status(201).json({ customer });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ message: 'A vehicle with this VIN already exists for the selected CCM.' });
    }
    throw error;
  }
}