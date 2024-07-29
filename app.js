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

console.log(process.env.CORS_ORIGIN);

const io = new Server(httpServer, {
  pingTimeout: 60000,
  cors: {
    origin: process.env.CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH"],
  },
});

app.set("io", io);

app.use(express.json());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cors());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  }),
);
app.use(passport.initialize());
app.use(passport.session());

// APPS ROUTES
app.use("/api/v1/auth/users", authRouter);
app.use("/api/v1/chat-app/chats", chatRouter);
app.use("/api/v1/chat-app/messages", messageRouter);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN);
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

/**w
 * INITIALIZE SOCKET
 */

initializeSocket(io);

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
  mongoose.connection.once("disconnect", () => {
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
