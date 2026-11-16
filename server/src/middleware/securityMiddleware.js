const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Idempotency-Key';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function getJwtSecret(env = process.env) {
  const secret = String(env.JWT_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters.');
  }
  return secret;
}

export function getAllowedOrigins(env = process.env) {
  const configured = String(env.CORS_ALLOWED_ORIGINS || '').trim();
  if (!configured) return env.NODE_ENV === 'production' ? [] : DEVELOPMENT_ORIGINS;

  return [...new Set(configured.split(',').map((value) => {
    const origin = value.trim();
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS must contain valid origins.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ALLOWED_ORIGINS entries must be exact HTTP(S) origins without paths or trailing slashes.');
    }
    return origin;
  }).filter(Boolean))];
}

export function assertSecurityConfiguration(env = process.env) {
  getJwtSecret(env);
  const origins = getAllowedOrigins(env);
  if (env.NODE_ENV === 'production' && (!origins.length || origins.some((origin) => !origin.startsWith('https://')))) {
    throw new Error('Production requires CORS_ALLOWED_ORIGINS with at least one HTTPS origin.');
  }
}

export function createSecurityMiddleware(allowedOrigins = getAllowedOrigins()) {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.get('Origin');
    const originAllowed = Boolean(origin && allowed.has(origin));

    res.vary('Origin');
    if (origin) {
      if (originAllowed) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
      }
    }

    if (req.method === 'OPTIONS') {
      return origin && !originAllowed ? res.sendStatus(403) : res.sendStatus(204);
    }

    if (!SAFE_METHODS.has(req.method) && req.cookies?.token && (!origin || !originAllowed)) {
      return res.status(403).json({ message: 'Request origin is not permitted.' });
    }

    return next();
  };
}
