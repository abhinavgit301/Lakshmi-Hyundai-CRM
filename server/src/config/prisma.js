import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured.');
}

const poolMax = Number.parseInt(process.env.DB_POOL_MAX, 10);
const adapter = new PrismaPg({
  connectionString,
  ...(poolMax > 0 ? { max: poolMax } : {}),
});

export const prisma = new PrismaClient({
  adapter,
});
