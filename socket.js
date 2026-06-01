// socket.js
import { Server } from "socket.io";
import { allowedOrigins } from "./util/cors.js";
import Logger from "./util/logger.js";

let io;

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000, 
  });

  io.on("connection", (socket) => {
    Logger.debug(`[Socket] Client connected: ${socket.id}`);

    socket.on("join_room", (conversationId) => {
       socket.join(conversationId);
       Logger.debug(`[Socket] ${socket.id} joined room: ${conversationId}`);
    });

    socket.on("disconnect", () => {
      Logger.debug(`[Socket] Client disconnected: ${socket.id}`);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};
