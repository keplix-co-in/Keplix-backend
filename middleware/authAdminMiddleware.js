import jwt from "jsonwebtoken";
import prisma from "../util/prisma.js";
import { isTokenBlacklisted } from "./authMiddleware.js";

const authAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;


  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token Missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Same access-token blacklist `protect` checks for regular users — without
    // this, logging an admin out (which only clears their refresh token) left
    // their still-valid access token usable until it expired on its own.
    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      return res.status(401).json({ message: "Token has been logged out" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // User and Admin are separate tables with overlapping autoincrement ids,
    // and both token families are signed with the same JWT_SECRET. Without
    // this check, an ordinary customer's access token (type: 'access')
    // verifies fine here and then matches an Admin row whenever their
    // User.id happens to equal an existing Admin.id — full admin takeover
    // with a login token that was never meant to touch this route at all.
    if (decoded.type !== "admin_access") {
      return res.status(401).json({ message: "Not authorized, invalid token type" });
    }

    // Re-check the admin against the DB on every request instead of trusting
    // the JWT payload's role/status forever. Without this, a deactivated or
    // suspended admin's existing access token kept working until it expired.
    const admin = await prisma.admin.findUnique({
      where: { id: decoded.id },
      select: { id: true, role: true, status: true },
    });

    if (!admin) {
      return res.status(401).json({ message: "Not authorized, admin not found" });
    }

    if (admin.status !== "ACTIVE") {
      return res.status(403).json({ message: "Admin account is not active" });
    }

    req.user = { id: admin.id, role: admin.role };
    next();
  }
  catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const allowedRoles = ["admin", "super_admin"];

const authorizeAdmin = (req, res, next) => {
  if(! req.user || !allowedRoles.includes(req.user.role)){
    return res.status(403).json({message: "Access Denied"});
  }
  next();

}

export  {authAdmin, authorizeAdmin};