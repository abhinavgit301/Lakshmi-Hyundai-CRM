import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/prisma.js';

const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret';

function normalizeRole(role) {
  const value = String(role || '').toUpperCase();

  if (value === 'ADMIN') return 'Admin';
  if (value === 'GM') return 'GM';
  if (value === 'CCM') return 'CCM';
  if (value === 'CRE') return 'CRE';
  if (value === 'FREE_SERVICE_CRE' || value === 'FREE-SERVICE CRE') return 'FREE_SERVICE_CRE';

  return value;
}

export function createToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: normalizeRole(user.role),
      ccmId: user.ccmId || null,
    },
    JWT_SECRET,
    {
      expiresIn: '8h',
    },
  );
}

export function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username || user.email?.split('@')[0] || '',
    phone: user.phone || null,
    role: normalizeRole(user.role),
    ccmId: user.ccmId,
    gmId: user.gmId || null,
    dealerCode: user.dealerCode || null,
    freeServiceEnabled: user.freeServiceEnabled === true,
    warrantyEnabled: user.warrantyEnabled === true,
    status: user.status,
  };
}

export async function login(req, res) {
  const { email, username, password } = req.body || {};
  const identifier = String(username || email || '').trim().toLowerCase();

  if (!identifier || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { username: identifier },
        { email: identifier },
      ],
    },
  });

  if (!user || user.status !== 'active') {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const passwordMatches = await bcrypt.compare(String(password), user.password);

  if (!passwordMatches) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const token = createToken(user);

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'none',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  });

  return res.status(200).json({
    message: 'Login successful.',
    token,
    user: sanitizeUser(user),
  });
}

export function getCurrentUser(req, res) {
  return res.status(200).json({
    user: sanitizeUser(req.user),
  });
}

export function logout(_req, res) {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'none',
    secure: process.env.NODE_ENV === 'production',
  });

  return res.status(200).json({
    message: 'User logged out successfully.',
  });
}
