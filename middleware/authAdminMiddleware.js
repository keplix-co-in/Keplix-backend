import { verifySupabaseToken } from "../util/supabaseAuth.js";
import prisma from "../util/prisma.js";
import { findAccountForSupabaseClaims } from "./authMiddleware.js";

/**
 * Admin auth, Supabase-only since the 2026-11 migration.
 *
 * The Supabase session proves who signed in; the Admin table decides whether
 * they are an admin. Being a customer/vendor User grants nothing here -- a
 * person is an admin only if an Admin row is linked (Admin.supabaseId) to
 * their Supabase user. The row is re-read on every request, so suspending an
 * admin takes effect immediately.
 *
 * Audit 2026-11-07 (HIGH): admins are matched by supabaseId ONLY -- no
 * first-sign-in email linking. Email-linking let anyone who could get a
 * Supabase session for an admin's address claim that Admin row. Existing
 * admins were linked by scripts/importUsersToSupabase.js; a new admin needs
 * Admin.supabaseId set when the row is created.
 */
const authAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token Missing" });
  }
  const token = authHeader.slice(7).trim();

  try {
    const claims = await verifySupabaseToken(token);
    const admin = await findAccountForSupabaseClaims(prisma.admin, claims, {
      select: { id: true, role: true, status: true },
    }, { allowEmailLink: false });

    if (!admin) {
      return res.status(401).json({ message: "Not authorized, admin not found" });
    }
    if (admin.status !== "ACTIVE") {
      return res.status(403).json({ message: "Admin account is not active" });
    }

    req.user = { id: admin.id, role: admin.role };
    next();
  } catch (error) {
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

// Destructive / money-moving endpoints (refund, payout settlement, force-
// complete, account deletion) had no privilege separation from ordinary
// admin read/write routes -- any "admin" role could do everything a
// "super_admin" could (audit #108). Mount this AFTER authAdmin+authorizeAdmin
// on those specific routes only; it does not replace authorizeAdmin.
const authorizeSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "super_admin") {
    return res.status(403).json({ message: "Access Denied: super_admin required" });
  }
  next();
};

export  {authAdmin, authorizeAdmin, authorizeSuperAdmin};