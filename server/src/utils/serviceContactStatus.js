import { getServiceLifecycle } from './serviceCalendar.js';
import { classifyServiceDue } from './serviceDue.js';
import { workshopVisitVisibilityWhere } from './creAccess.js';

export function isServiceContactStatusEnabled(env = process.env) {
  return ['true', '1'].includes(String(env.SERVICE_CONTACT_STATUS_ENABLED || '').trim().toLowerCase());
}

export function serviceCohortKey(window, now) {
  if (!window) return null;
  return `${window}:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function resolveServiceContactStatus(vehicle, window, now) {
  if (!vehicle) return 'pending';
  if (window && vehicle.serviceStatusCohort !== serviceCohortKey(window, now)) return 'pending';
  return vehicle.serviceContactStatus || 'pending';
}

export function statusForServiceCall(outcome, followUpAt) {
  if (followUpAt) return 'follow-up';
  if (['CONTACTED', 'NOT_INTERESTED', 'OTHER'].includes(outcome)) return 'contacted';
  return null;
}

export async function saveServiceContactStatus(transaction, { vehicleId, ccmId, user, status, now = new Date() }) {
  const vehicle = await transaction.vehicle.findFirst({
    where: { id: vehicleId, ccmId },
    select: {
      saleDate: true,
      physicalVehicle: {
        select: {
          workshopVisits: {
            where: workshopVisitVisibilityWhere(user),
            select: { visitDate: true, importedDetails: true },
            orderBy: [{ visitDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
          },
        },
      },
    },
  });
  if (!vehicle) throw new Error('Vehicle not found while updating service contact status.');
  const lifecycle = getServiceLifecycle({
    saleDate: vehicle.saleDate,
    workshopVisits: vehicle.physicalVehicle?.workshopVisits || [],
  }, now);
  const window = classifyServiceDue(lifecycle.referenceDate, now);
  await transaction.vehicle.update({
    where: { id: vehicleId, ccmId },
    data: { serviceContactStatus: status, serviceStatusCohort: serviceCohortKey(window, now) },
  });
}
