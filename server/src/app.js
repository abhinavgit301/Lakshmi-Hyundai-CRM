import express from 'express';
import apiRoutes from './routes/api.js';

const app = express();

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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Idempotency-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  return next();
});

app.use('/api/v1', apiRoutes);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    message: 'An unexpected error occurred.',
  });
});

export default app;
