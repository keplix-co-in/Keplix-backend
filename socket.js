// socket.js
import { Server } from "socket.io";
import { allowedOrigins } from "./util/cors.js"; // Ensure this import matches your cors file

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
    console.log("✅ New client connected:", socket.id);

    socket.on("join_room", (conversationId) => {
       // Ideally, sanitize or validate room IDs here
       socket.join(conversationId);
       console.log(`👥 Socket ${socket.id} joined room: ${conversationId}`);
       console.log(`📊 Room ${conversationId} now has ${io.sockets.adapter.rooms.get(conversationId)?.size || 0} members`);
    });

    socket.on("disconnect", () => {
      console.log("❌ Client disconnected:", socket.id);
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
