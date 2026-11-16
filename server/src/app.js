import compression from 'compression';
import express from 'express';
import apiRoutes from './routes/api.js';
import { createSecurityMiddleware, getAllowedOrigins } from './middleware/securityMiddleware.js';
import { callListCacheMiddleware } from './utils/callListCache.js';
import { performanceDirtyMiddleware } from './utils/performanceDirty.js';

const app = express();
const securityMiddleware = createSecurityMiddleware(getAllowedOrigins());

app.use(compression());
app.use(callListCacheMiddleware);
app.use(performanceDirtyMiddleware);

app.use((req, res, next) => {
  const rawCookieHeader = req.headers.cookie || '';
  const cookies = {};

  for (const chunk of rawCookieHeader.split(';')) {
    const [key, ...rest] = chunk.trim().split('=');
    if (key) {
      cookies[key] = decodeURIComponent(rest.join('='));
    }
  }

  req.cookies = cookies;
  next();
});

app.use(securityMiddleware);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/v1', apiRoutes);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    message: 'An unexpected error occurred.',
  });
});

export default app;
