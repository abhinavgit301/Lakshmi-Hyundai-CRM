import { normalizeVin } from './roleAccess.js';

export async function lockPhysicalVehicleIdentity(transaction, vin) {
  const normalizedVin = normalizeVin(vin);
  if (!normalizedVin) throw new Error('Physical vehicle identity requires a valid VIN.');
  await transaction.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`physical-vehicle:${normalizedVin}`}, 0))) AS physical_vehicle_lock`;
  return normalizedVin;
}

export async function findOrCreatePhysicalVehicle(transaction, vin) {
  const normalizedVin = await lockPhysicalVehicleIdentity(transaction, vin);
  const existing = await transaction.physicalVehicle.findUnique({ where: { vin: normalizedVin } });
  if (existing) return existing;
  return transaction.physicalVehicle.create({ data: { vin: normalizedVin } });
}
