import bcrypt from 'bcrypt';
import { prisma } from './prisma.js';

const DEMO_USERS = [
  {
    name: 'Asha Menon',
    username: 'admin',
    email: 'admin@lakshmi.com',
    password: 'Password123!',
    role: 'ADMIN',
    status: 'active',
    ccmId: null,
  },
  {
    name: 'Rohan Iyer',
    username: 'gm',
    email: 'gm@lakshmi.com',
    password: 'Password123!',
    role: 'GM',
    status: 'active',
    ccmId: null,
  },
  {
    name: 'Naveen Kumar',
    username: 'ccm',
    email: 'ccm@lakshmi.com',
    password: 'Password123!',
    role: 'CCM',
    status: 'active',
    ccmId: 'ccm-1',
    gmUsername: 'gm',
  },
  {
    name: 'Priya S.',
    username: 'cre',
    email: 'cre@lakshmi.com',
    password: 'Password123!',
    role: 'CRE',
    status: 'active',
    ccmId: 'ccm-1',
  },
];

export async function ensureDemoUsers(db = prisma) {
  const existing = await db.user.findMany({
    where: {
      email: {
        in: DEMO_USERS.map((user) => user.email),
      },
    },
    select: { id: true, email: true, username: true, role: true, gmId: true },
  });

  const existingByEmail = new Map(existing.filter((user) => user.email).map((user) => [user.email, user]));

  for (const user of DEMO_USERS) {
    const existingUser = existingByEmail.get(user.email);

    if (!existingUser) {
      const gmAccount = user.gmUsername ? DEMO_USERS.find((candidate) => candidate.username === user.gmUsername) : null;
      const gm = gmAccount ? existingByEmail.get(gmAccount.email) : null;
      const created = await db.user.create({
        data: {
          name: user.name,
          username: user.username,
          email: user.email,
          password: await bcrypt.hash(user.password, 10),
          role: user.role,
          status: user.status,
          ccmId: user.ccmId || null,
          gmId: user.gmUsername && gm ? gm.id : null,
        },
      });
      existingByEmail.set(user.email, created);
      continue;
    }

    const gmAccount = user.gmUsername ? DEMO_USERS.find((candidate) => candidate.username === user.gmUsername) : null;
    const gm = gmAccount ? existingByEmail.get(gmAccount.email) : null;
    const updates = {};
    if (!existingUser.username) updates.username = user.username;
    if (user.role === 'CCM' && !existingUser.gmId && gm) updates.gmId = gm.id;
    if (Object.keys(updates).length) {
      await db.user.update({ where: { id: existingUser.id }, data: updates });
    }
  }
}
