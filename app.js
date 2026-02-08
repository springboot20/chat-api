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

import { errorHandler } from './middlewares/error.middleware.js';
import { router as authRouter } from './routes/auth/auth.routes.js';
import { router as chatRouter } from './routes/chat/chat.routes.js';
import { router as messageRouter } from './routes/chat/message.routes.js';
import { router as statusRouter } from './routes/chat/status.routes.js';
import { setupStatusCleanupJob } from './service/cron-jobs.js';

const app = express();
const PORT = process.env.PORT || 4020;
const httpServer = http.createServer(app);

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get CORS origin from environment or use a fallback
const corsOrigin = process.env.CORS_ORIGIN || 'https://codesuite-chatting-application.vercel.app';
console.log('CORS Origin:', corsOrigin);

// Configure CORS middleware first before any routes
app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);

// Handle preflight OPTIONS requests
app.options(
  '*',
  cors({
    origin: corsOrigin,
    optionsSuccessStatus: 204,
  }),
);

// Setup Socket.io with proper CORS
const io = new Server(httpServer, {
  pingTimeout: 60000,
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  },
});

// Initialize socket
initializeSocket(io);

app.set('io', io);

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

// Setup middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
// Configure session
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
  }),
);
app.use(passport.initialize());
app.use(passport.session());

// API Routes
app.use('/api/v1/auth/users', authRouter);
app.use('/api/v1/chat-app/chats', chatRouter);
app.use('/api/v1/chat-app/messages', messageRouter);
app.use('/api/v1/chat-app/statuses', statusRouter);

mongoose.connection.on('connected', () => {
  console.log('Mongodb connected ....');
});

mongoose.connection.once('open', () => {
  console.log('✅ Database connected');
  
  // Start cron jobs
  setupStatusCleanupJob();
});

process.on('SIGINT', () => {
  mongoose.connection.close(() => {
    console.log('Mongodb disconnected..... ');
    process.exit(0);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀🚀 Server running on http://localhost:${PORT} ✨✨`);
});

httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} already in use`);
  }
  console.log(`Server Error : ${error}`);
});

/**
 * DATABASE CONNECTION
 */
dataBaseConnection()
  .then((conn) => {
    console.log(`MongoDB connected successfully: ${conn.connection.host}`);
  })
  .catch((error) => {
    console.log(error);
    process.exit(1);
  });

// Error handling
app.use(errorHandler);
