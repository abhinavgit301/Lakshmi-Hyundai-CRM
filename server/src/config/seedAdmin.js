import bcrypt from 'bcrypt';
import { prisma } from './prisma.js';

const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@lakshmi.com';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Password123!';

export async function ensureFirstAdmin(db = prisma) {
  const defaultUsername = DEFAULT_ADMIN_EMAIL.split('@')[0].toLowerCase();
  const existingAdmin = await db.user.findFirst({
    where: {
      OR: [
        { email: DEFAULT_ADMIN_EMAIL },
        { username: defaultUsername },
        { role: 'ADMIN' },
      ],
    },
  });

  if (existingAdmin) {
    return existingAdmin;
  }

  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);

  const admin = await db.user.create({
    data: {
      name: 'System Admin',
      username: defaultUsername,
      email: DEFAULT_ADMIN_EMAIL,
      password: passwordHash,
      role: 'ADMIN',
      status: 'active',
      team: 'Executive Office',
    },
  });

  return admin;
}
