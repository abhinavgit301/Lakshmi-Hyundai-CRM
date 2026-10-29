import bcrypt from 'bcrypt';
import { prisma } from './prisma.js';

export async function ensureFirstAdmin(db = prisma, {
  enabled = process.env.ADMIN_BOOTSTRAP_ENABLED === 'true',
  email = process.env.ADMIN_EMAIL,
  password = process.env.ADMIN_PASSWORD,
} = {}) {
  const existingAdmin = await db.user.findFirst({ where: { role: 'ADMIN' } });
  if (existingAdmin) {
    return existingAdmin;
  }

  if (!enabled) return null;
  const bootstrapEmail = String(email || '').trim().toLowerCase();
  const bootstrapPassword = String(password || '');
  if (!bootstrapEmail || !bootstrapPassword) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required when ADMIN_BOOTSTRAP_ENABLED is true.');
  }

  const username = bootstrapEmail.split('@')[0];
  const conflictingUser = await db.user.findFirst({
    where: { OR: [{ email: bootstrapEmail }, { username }] },
  });
  if (conflictingUser) {
    throw new Error('Configured administrator identity is already used by a non-admin account.');
  }

  const passwordHash = await bcrypt.hash(bootstrapPassword, 10);
  return db.user.create({
    data: {
      name: 'System Admin',
      username,
      email: bootstrapEmail,
      password: passwordHash,
      role: 'ADMIN',
      status: 'active',
      team: 'Executive Office',
    },
  });
}
