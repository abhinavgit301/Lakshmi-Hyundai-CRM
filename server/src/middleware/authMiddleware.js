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

export async function authMiddleware(req, res, next) {
  const authorization = req.headers.authorization || '';
  const cookieToken = req.cookies?.token;
  const token = cookieToken || authorization.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
    });

    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }

    if (user.status !== 'active') {
      return res.status(401).json({ message: 'Account is inactive.' });
    }

    req.user = {
      ...user,
      role: normalizeRole(user.role),
    };

    return next();
  } catch (_error) {
    return res.status(401).json({ message: 'Token is invalid or expired.' });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    const userRole = normalizeRole(req.user.role);
    const allowed = allowedRoles.map((role) => normalizeRole(role));

    if (!allowed.includes(userRole)) {
      return res.status(403).json({ message: 'You do not have permission to access this area.' });
    }

    return next();
  };
}
