import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
//
// Configurations
dotenv.config();
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allow all origins for development
        methods: ["GET", "POST"]
    }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/media', express.static(path.join(__dirname, 'media')));

// Database Check Route
app.get('/', (req, res) => {
    res.json({ message: "Keplix Backend (Node.js) is running!" });
});

// Import Routes (To be implemented)
import authRoutes from './routes/auth.js';
// Vendor Routes
import vendorServiceRoutes from './routes/vendor/services.js';
import vendorBookingRoutes from './routes/vendor/bookings.js';
import inventoryRoutes from './routes/inventory.js'; // Need to update route file import path
import availabilityRoutes from './routes/availability.js'; // Need to update route file import path
import documentRoutes from './routes/documents.js'; // Need to update route file import path
import promotionRoutes from './routes/promotions.js'; // Need to update route file import path

// User Routes
import userServiceRoutes from './routes/user/services.js';
import userBookingRoutes from './routes/user/bookings.js';
import feedbackRoutes from './routes/feedback.js'; // Need to update route file import path
import reviewRoutes from './routes/reviews.js'; // Need to update route file import path

// Shared/Interaction Routes
import interactionRoutes from './routes/interactions.js';
import notificationRoutes from './routes/notifications.js';
import paymentRoutes from './routes/payments.js';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

app.use('/accounts/auth', authRoutes);

// Vendor API Group
app.use('/accounts/documents', documentRoutes);
app.use('/service_api/vendor', vendorServiceRoutes); // mounts /service_api/vendor/services
app.use('/service_api/vendor', vendorBookingRoutes); // mounts /service_api/vendor/bookings
app.use('/service_api', inventoryRoutes); // Keeps /service_api/vendor/:id/inventory
app.use('/service_api', availabilityRoutes); // Keeps /service_api/vendor/:id/availability
app.use('/interactions/api/promotions', promotionRoutes);

// User API Group
app.use('/service_api/user', userServiceRoutes); // mounts /service_api/user/services
app.use('/service_api/user', userBookingRoutes); // mounts /service_api/user/bookings
app.use('/service_api', userServiceRoutes); // For shared search routes like /service_api/search
// Note: /service_api/services/:id is also in user service controller, but mounted under /user currently?
// Let's ensure public routes work. userServiceRoutes has /services (public), /search etc.
// We might need to mount it at /service_api too for the public endpoints
app.use('/service_api', userServiceRoutes);

app.use('/interactions/api/feedback', feedbackRoutes);
app.use('/interactions/api', reviewRoutes);

// Shared
app.use('/service_api', paymentRoutes);
app.use('/interactions/api', interactionRoutes);
app.use('/interactions/api', notificationRoutes); // Check BASE_URL/interactions/api/

// Socket.io Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`User ${socket.id} joined room ${room}`);
    });

    socket.on('send_message', async (data) => {
        // data: { room, message, senderId, conversationId }
        try {
            if (data.conversationId && data.message && data.senderId) {
                const savedMessage = await prisma.message.create({
                    data: {
                        conversationId: parseInt(data.conversationId),
                        senderId: parseInt(data.senderId),
                        message_text: data.message
                    },
                    include: { sender: true }
                });

                // Emit detailed object
                io.to(data.room).emit('receive_message', savedMessage);
            } else {
                // Fallback for testing
                io.to(data.room).emit('receive_message', data);
            }
        } catch (e) {
            console.error("Socket Error", e);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = 8000; // Using 8000 to match Django default
httpServer.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});
