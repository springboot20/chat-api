import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import express from 'express';
import url from 'url';
import path from 'path';
import http from 'http';
import fs from 'fs';
import mongoose from 'mongoose';
import cors from 'cors';
import { Server } from 'socket.io';
import session from 'express-session';
import passport from 'passport';

import { dataBaseConnection } from './db/connection.js';
import { initializeSocket } from './socketIo/socket.js';
import { RedisStore } from 'connect-redis';
import redisClient from './configs/redis.config.js';

import { errorHandler } from './middlewares/error.middleware.js';
import { router as authRouter } from './routes/auth/auth.routes.js';
import { router as chatRouter } from './routes/chat/chat.routes.js';
import { router as messageRouter } from './routes/chat/message.routes.js';
import { router as statusRouter } from './routes/chat/status.routes.js';
import { router as contactRouter } from './routes/contact/contact.routes.js';
import { setupStatusCleanupJob } from './service/cron-jobs.js';
import { rateLimit } from 'express-rate-limit';
import { RedisStore as RateLimitRedisStore } from 'rate-limit-redis';

const app = express();
const PORT = process.env.PORT || 4020;
const httpServer = http.createServer(app);

// Global rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RateLimitRedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }),
  handler: (req, res, next, options) => {
    // This ensures headers are sent even if the middleware order is tricky
    res.status(options.statusCode).send(options.message);
  },
});

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : []),
];

console.log('Allowed CORS origins:', allowedOrigins);

/**
 * @type {cors.CorsOptions}
 */
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use('/api/', limiter);

// ─── Socket.io ────────────────────────────────────────────────────────────────

const io = new Server(httpServer, {
  pingTimeout: 60000,
  cors: corsOptions,
  // cors: {
  //   origin: allowedOrigins,
  //   methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  //   credentials: true,
  // },
});

initializeSocket(io);
app.set('io', io);

// ─── Directory setup ──────────────────────────────────────────────────────────

const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const voicesDir = path.join(uploadsDir, 'voices');
const documentsDir = path.join(uploadsDir, 'documents');
const imagesDir = path.join(uploadsDir, 'images');

[publicDir, uploadsDir, voicesDir, documentsDir, imagesDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new RedisStore({ client: redisClient, prefix: 'session:' }),
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/v1/chat-app/auth/users', authRouter);
app.use('/api/v1/chat-app/chats', chatRouter);
app.use('/api/v1/chat-app/messages', messageRouter);
app.use('/api/v1/chat-app/statuses', statusRouter);
app.use('/api/v1/chat-app/contacts', contactRouter);

// ─── Database ─────────────────────────────────────────────────────────────────

mongoose.connection.on('connected', () => {
  console.log('Mongodb connected ....');
});

mongoose.connection.once('open', () => {
  console.log('✅ Database connected');
  setupStatusCleanupJob();
});

process.on('SIGINT', () => {
  mongoose.connection.close(() => {
    console.log('Mongodb disconnected..... ');
    process.exit(0);
  });
});

dataBaseConnection()
  .then((conn) => {
    console.log(`MongoDB connected successfully: ${conn.connection.host}`);
  })
  .catch((error) => {
    console.log(error);
    process.exit(1);
  });

// ─── Server ───────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀🚀 Server running on http://localhost:${PORT} ✨✨`);
});

httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} already in use`);
  }
  console.log(`Server Error : ${error}`);
});

// ─── Error handling ───────────────────────────────────────────────────────────

app.use(errorHandler);
