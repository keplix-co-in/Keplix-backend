import jwt from "jsonwebtoken";
import prisma from "../util/prisma.js";


const JWT_SECRET =
  process.env.JWT_SECRET || "django-insecure-secret-key-replacement";

export const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];

      //check if token is blacklisted (added during logout)

      const blacklisted = await prisma.blacklistedToken.findUnique({
        where: { token },
      });

      if (blacklisted) {
        return res.status(401).json({ message: "Token has been logged out" });
      }

      const decoded = jwt.verify(token, JWT_SECRET);

      req.user = await prisma.user.findUnique({
        where: { id: decoded.id },
        include: { userProfile: true, vendorProfile: true },
      });

            if (!req.user) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }
            
            // Check for activity if needed (can be separate middleware but good safety net)
            if (req.user.is_active === false) {
                 return res.status(403).json({ message: 'Account is inactive' });
            }

      next();
    } catch (error) {
      console.error('Auth Middleware Error:', error);
      const message =
        error.message === "Not authorized, user not found" ||
        error.message === "Account is inactive"
          ? error.message
          : "Not authorized, token failed";
      return res.status(401).json({ message });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

