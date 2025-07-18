import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import url from "url";
import path from "path";
import http from "http";
import mongoose from "mongoose";
import cors from "cors";
import bodyParser from "body-parser";
import { Server } from "socket.io";
import session from "express-session";
import passport from "passport";

import { dataBaseConnection } from "./db/connection.js";
import { initializeSocket } from "./socketIo/socket.js";

import { errorHandler } from "./middlewares/error.middleware.js";
import { router as authRouter } from "./routes/auth/auth.routes.js";
import { router as chatRouter } from "./routes/chat/chat.routes.js";
import { router as messageRouter } from "./routes/chat/message.routes.js";

const app = express();
const PORT = process.env.PORT || 4020;
const httpServer = http.createServer(app);

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get CORS origin from environment or use a fallback
const corsOrigin = process.env.CORS_ORIGIN || "https://chat-application-wine-six.vercel.app";
console.log("CORS Origin:", corsOrigin);

// Configure CORS middleware first before any routes
app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-access-token"],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// Handle preflight OPTIONS requests
app.options(
  "*",
  cors({
    origin: corsOrigin,
    optionsSuccessStatus: 204,
  })
);

// Setup Socket.io with proper CORS
const io = new Server(httpServer, {
  pingTimeout: 60000,
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  },
});

// Initialize socket
initializeSocket(io);

app.set("io", io);

// Setup middleware
app.use(express.json());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Configure session
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-secret-key",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

// Set CORS headers for all responses
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", corsOrigin);
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-access-token"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

// API Routes
app.use("/api/v1/auth/users", authRouter);
app.use("/api/v1/chat-app/chats", chatRouter);
app.use("/api/v1/chat-app/messages", messageRouter);

// Error handling
app.use(errorHandler);

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

mongoose.connection.on("connected", () => {
  console.log("Mongodb connected ....");
});

process.on("SIGINT", () => {
  mongoose.connection.close(() => {
    console.log("Mongodb disconnected..... ");
    process.exit(0);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀🚀 Server running on http://localhost:${PORT} ✨✨`);
});

httpServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Port ${PORT} already in use`);
  }
  console.log(`Server Error : ${error}`);
});
