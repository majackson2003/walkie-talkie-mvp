import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { createSocketService } from './services/socketService';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 120);

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = new Set(
  CLIENT_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const isOriginAllowed = (origin?: string | null) => {
  if (!origin) {
    return true;
  }
  return allowedOrigins.has(origin);
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const ip = req.ip;
    console.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms ${ip}`);
  });
  next();
});

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => {
  const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterMs = Math.max(0, entry.resetAt - now);
    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
    res.status(429).json({ error: 'rate_limited', retryAfterMs });
    return;
  }

  entry.count += 1;
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

if (process.env.NODE_ENV === 'production') {
  const staticDir = path.resolve(__dirname, '../public');
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

createSocketService(io);

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
