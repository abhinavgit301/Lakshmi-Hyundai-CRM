import { randomUUID } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { validateCustomerPayload } from '../utils/customerRules.js';

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

  if (ccmId) {
    const ccm = await prisma.user.findFirst({
      where: { role: 'CCM', ccmId, status: 'active' },
      select: { id: true },
    });
    if (!ccm) return res.status(400).json({ message: 'CCM assignment is invalid.' });
  }

  const { fullName, mobileNumber, alternatePhone, email, vehicles } = validation.value;

  try {
    const customer = await prisma.customer.create({
      data: {
        customerCode: `CUS-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        fullName,
        mobileNumber,
        alternatePhone,
        email,
        ccmId,
        vehicles: {
          create: vehicles.map((vehicle) => ({ ...vehicle, ccmId })),
        },
      },
      include: { vehicles: true },
    });

    return res.status(201).json({ customer });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ message: 'A vehicle VIN or registration number already exists.' });
    }
    throw error;
  }
}