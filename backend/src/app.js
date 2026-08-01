import cors from 'cors';
import express from 'express';
import authRoutes from './routes/authRoutes.js';
import monitoringRoutes from './routes/monitoringRoutes.js';
import userRoutes from './routes/userRoutes.js';

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Tether-monitoring' });
});

app.use('/api', authRoutes);
app.use('/api', monitoringRoutes);
app.use('/api', userRoutes);

app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  const isDuplicateKey = error?.code === 11000;
  const status = error.status || (isDuplicateKey ? 409 : 500);
  res.status(status).json({
    message: isDuplicateKey ? 'A user with these credentials already exists.' : error.message || 'Internal server error',
  });
});

export default app;
