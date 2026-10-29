import { prisma } from '../config/prisma.js';
import { appointmentVisibilityWhere, normalizeAppointmentRole } from '../utils/appointmentAccess.js';
import { validateAppointmentPayload, validateAppointmentUpdate } from '../utils/appointmentRules.js';
import { isVehicleAssignedToCre } from '../utils/creAccess.js';

async function findBookableCustomer(customerId, user) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { vehicles: { include: { allocations: true, masterCallListEntries: true } } },
  });
  if (!customer) return null;

  const role = normalizeAppointmentRole(user?.role);
  if (role === 'Admin' || role === 'GM') return customer;
  if (!user?.ccmId || customer.ccmId !== user.ccmId) return null;
  if (role === 'CCM') return customer;

  return customer.vehicles.some((vehicle) => isVehicleAssignedToCre(vehicle, user)) ? customer : null;
}

async function validateAssignee(assigneeId, user, ccmId) {
  if (!assigneeId) return null;
  const assignee = await prisma.user.findFirst({
    where: { id: assigneeId, role: 'CRE', status: 'active' },
    select: { id: true, ccmId: true },
  });
  if (!assignee) return false;

  const role = normalizeAppointmentRole(user?.role);
  if ((role === 'CCM' || role === 'CRE') && assignee.ccmId !== user.ccmId) return false;
  if (ccmId && assignee.ccmId !== ccmId) return false;
  return assignee.id;
}

export async function createAppointment(req, res) {
  const role = normalizeAppointmentRole(req.user?.role);
  if (role === 'FREE_SERVICE_CRE' && req.body?.customerId) {
    return res.status(403).json({ message: 'Free-Service CRE appointments cannot use Master Call List customer records.' });
  }
  if (role === 'FREE_SERVICE_CRE' && req.body?.vehicleId) {
    return res.status(403).json({ message: 'Free-Service CRE appointments cannot use Master Call List vehicles.' });
  }
  const validation = validateAppointmentPayload(req.body, { allowCustomerless: role === 'FREE_SERVICE_CRE' });
  if (validation.error) return res.status(400).json({ message: validation.error });

  const { customerId, customerName, vehicleName, vehicleId, assigneeId, scheduledAt, confirmationCall } = validation.value;
  const customerlessAppointment = role === 'FREE_SERVICE_CRE';
  const customer = customerlessAppointment ? null : await findBookableCustomer(customerId, req.user);
  if (!customerlessAppointment && !customer) return res.status(404).json({ message: 'Customer not found.' });

  let vehicle = null;
  if (vehicleId && customer) {
    vehicle = customer.vehicles.find((entry) => entry.id === vehicleId);
    if (!vehicle || vehicle.status !== 'ACTIVE') {
      return res.status(400).json({ message: 'Select an active vehicle belonging to this customer.' });
    }
    if (normalizeAppointmentRole(req.user.role) === 'CRE' && !isVehicleAssignedToCre(vehicle, req.user)) {
      return res.status(404).json({ message: 'Customer not found.' });
    }
  }

  let assignedToId = assigneeId;
  if (role === 'CRE' || customerlessAppointment) assignedToId = req.user.id;
  if (assignedToId && !customerlessAppointment) {
    const validatedAssignee = await validateAssignee(assignedToId, req.user, customer?.ccmId || req.user.ccmId);
    if (validatedAssignee === false) return res.status(400).json({ message: "Assignee must be an active CRE in the customer's team." });
    assignedToId = validatedAssignee;
  }

  const ccmId = customer?.ccmId || req.user.ccmId || null;
  const result = await prisma.$transaction(async (transaction) => {
    const appointment = await transaction.appointment.create({
      data: {
        customerId: customer?.id || null,
        vehicleId: vehicle?.id || null,
        customerName: customer?.fullName || customerName,
        vehicleName: vehicle ? [vehicle.model, vehicle.registrationNumber].filter(Boolean).join(' / ') || vehicle.vin : vehicleName || 'Vehicle to be confirmed',
        scheduledAt,
        ccmId,
        assigneeId: assignedToId,
        createdById: req.user.id,
        confirmationCall,
      },
      include: {
        customer: { select: { id: true, fullName: true, mobileNumber: true } },
        vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
      },
    });
    await transaction.appointmentEvent.create({
      data: { appointmentId: appointment.id, eventType: 'CREATED', notes: `Created by ${req.user.name}` },
    });
    return appointment;
  });

  return res.status(201).json({ appointment: result });
}

export async function deleteAppointment(req, res) {
  const existing = await prisma.appointment.findFirst({
    where: { id: req.params.id, ...appointmentVisibilityWhere(req.user) },
  });
  if (!existing) return res.status(404).json({ message: 'Appointment not found.' });

  await prisma.$transaction([
    prisma.appointmentEvent.deleteMany({ where: { appointmentId: existing.id } }),
    prisma.appointment.delete({ where: { id: existing.id } }),
  ]);

  return res.json({ id: existing.id });
}

export async function updateAppointment(req, res) {
  const validation = validateAppointmentUpdate(req.body);
  if (validation.error) return res.status(400).json({ message: validation.error });

  const where = appointmentVisibilityWhere(req.user);
  const existing = await prisma.appointment.findFirst({
    where: { id: req.params.id, ...where },
  });
  if (!existing) return res.status(404).json({ message: 'Appointment not found.' });

  const events = [];
  if (validation.value.status && validation.value.status !== existing.status) {
    events.push({ eventType: 'STATUS_CHANGED', notes: `${existing.status} -> ${validation.value.status}` });
  }
  if (validation.value.scheduledAt && validation.value.scheduledAt.getTime() !== existing.scheduledAt.getTime()) {
    events.push({ eventType: 'RESCHEDULED', notes: `${existing.scheduledAt.toISOString()} -> ${validation.value.scheduledAt.toISOString()}` });
    if (!validation.value.status) validation.value.status = 'RESCHEDULED';
  }
  if (validation.value.confirmationCall != null && validation.value.confirmationCall !== existing.confirmationCall) {
    events.push({ eventType: 'CONFIRMATION_UPDATED', notes: `confirmationCall=${validation.value.confirmationCall}` });
  }

  const appointment = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.appointment.update({
      where: { id: existing.id },
      data: validation.value,
      include: {
        customer: { select: { id: true, fullName: true, mobileNumber: true } },
        vehicle: { select: { id: true, vin: true, model: true, registrationNumber: true } },
      },
    });
    if (events.length) {
      await transaction.appointmentEvent.createMany({
        data: events.map((event) => ({ ...event, appointmentId: existing.id })),
      });
    }
    return updated;
  });

  return res.json({ appointment });
}