import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'django-insecure-secret-key-replacement';

export const protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            token = req.headers.authorization.split(' ')[1];

            const decoded = jwt.verify(token, JWT_SECRET);

            req.user = await prisma.user.findUnique({
                where: { id: decoded.id },
                include: { userProfile: true, vendorProfile: true }
            });

            if (!req.user) {
                res.status(401);
                throw new Error('Not authorized, user not found');
            }
            
            // Check for activity if needed (can be separate middleware but good safety net)
            if (req.user.is_active === false) {
                 res.status(403);
                 throw new Error('Account is inactive');
            }

            next();
        } catch (error) {
            console.error(error);
            res.status(401);
            // If it's our error, pass message, otherwise generic "Token failed"
            const message = error.message === 'Not authorized, user not found' || error.message === 'Account is inactive' 
                ? error.message 
                : 'Not authorized, token failed';
            throw new Error(message);
        }
    }

    if (!token) {
        res.status(401);
        throw new Error('Not authorized, no token');
    }
};
