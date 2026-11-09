import prisma from "../util/prisma.js";
import { signPrivateUrl } from "../util/cloudinary.js";
import { findAccountForSupabaseClaims } from "../middleware/authMiddleware.js";
import { getIO } from "../socket.js";
import { disconnectTokenSockets } from "../util/socketSessions.js";

// Self-signup may only ever create these. "admin" etc. never come from here.
const ALLOWED_SIGNUP_ROLES = ["user", "vendor"];

const WITH_PROFILES = { include: { userProfile: true, vendorProfile: true } };

/**
 * The user object both apps already route on after sign-in (the same shape
 * googleLogin used to return), so landing/onboarding logic is unchanged.
 */
export const buildUserData = (user) => {
  const userData = {
    id: user.id,
    email: user.email,
    role: user.role,
    is_active: user.is_active,
  };
  if (user.role === "vendor" && user.vendorProfile) {
    const v = user.vendorProfile;
    Object.assign(userData, {
      business_name: v.business_name,
      name: v.business_name,
      phone: v.phone,
      phone_number: v.phone,
      address: v.address,
      image: v.image,
      cover_image: v.cover_image,
      onboarding_completed: v.onboarding_completed,
      status: v.status,
    });
  } else if (user.userProfile) {
    const p = user.userProfile;
    Object.assign(userData, {
      name: p.name,
      phone: p.phone,
      phone_number: p.phone,
      address: p.address,
      profile_picture: p.profile_picture,
      // Security A-015: signed, short-lived URLs for private ID proofs.
      id_proof_front: signPrivateUrl(p.id_proof_front),
      id_proof_back: signPrivateUrl(p.id_proof_back),
    });
  }
  return userData;
};

/** Creates whichever profile row the account is missing (never overwrites). */
const ensureProfile = async (user, name) => {
  if (user.role === "vendor" && !user.vendorProfile) {
    await prisma.vendorProfile.create({
      data: { userId: user.id, business_name: name, phone: "", onboarding_completed: false },
    });
  } else if (user.role !== "vendor" && !user.userProfile) {
    await prisma.userProfile.create({ data: { userId: user.id, name, phone: "" } });
  } else {
    return user;
  }
  return prisma.user.findUnique({ where: { id: user.id }, ...WITH_PROFILES });
};

// @desc    After any Supabase sign-in: link or create the Keplix account
// @route   POST /accounts/auth/supabase/sync
// @access  Supabase session (requireSupabaseSession)
// @body    { role?: "user"|"vendor", name?: string } -- only used when creating
export const syncSupabaseUser = async (req, res) => {
  const claims = req.supabaseClaims;
  if (!claims?.email) {
    return res.status(400).json({ message: "Your sign-in has no email address." });
  }

  const role = ALLOWED_SIGNUP_ROLES.includes(req.body?.role) ? req.body.role : "user";
  const rawName = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
  const name = rawName || claims.email.split("@")[0];

  try {
    let user = await findAccountForSupabaseClaims(prisma.user, claims, WITH_PROFILES);
    let isNewUser = false;

    if (!user) {
      // A row with this email that did NOT link (linked to a different
      // Supabase user, or the email is unconfirmed) must never be duplicated
      // or taken over.
      const clash = await prisma.user.findFirst({
        where: { email: { equals: claims.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (clash) {
        return res.status(409).json({
          code: "ACCOUNT_LINK_FAILED",
          message: "This email belongs to an existing account that could not be linked. Please contact support.",
        });
      }

      isNewUser = true;
      try {
        user = await prisma.user.create({
          data: {
            email: claims.email,
            role,
            is_active: true,
            is_verified: true,
            supabaseId: claims.sub,
          },
          ...WITH_PROFILES,
        });
      } catch (error) {
        // Two sync calls racing (e.g. a double tap): the other one won.
        if (error?.code !== "P2002") throw error;
        isNewUser = false;
        user = await prisma.user.findFirst({ where: { supabaseId: claims.sub }, ...WITH_PROFILES });
        if (!user) throw error;
      }
    }

    if (user.is_active === false) {
      return res.status(403).json({ message: "Account is inactive" });
    }

    user = await ensureProfile(user, name);
    return res.json({ user: buildUserData(user), isNewUser });
  } catch (error) {
    console.error("Supabase sync error:", error);
    return res.status(500).json({ message: "Could not finish signing in. Please try again." });
  }
};

// @desc    Old login/refresh/OTP routes, retired by the Supabase migration.
//          426 lets old app builds show "please update" instead of a crash.
export const legacyAuthRetired = (req, res) =>
  res.status(426).json({
    code: "APP_UPDATE_REQUIRED",
    message: "Sign-in has been upgraded. Please update the Keplix app (or refresh the page) and sign in again.",
  });

// @desc    Logout. The app signs out of Supabase itself; 200 so old builds
//          still clear locally.
//
// Audit 2026-11-07 (revocation gap): a socket authenticates once at handshake
// and stays open, so drop the live sockets opened with THIS token (other
// devices keep theirs -- see util/socketSessions.js tokenRoom). No token
// verification is needed: the room name is a hash of the token, so only the
// token's holder can target those sockets.
export const legacyLogout = (req, res) => {
  const header = req.headers?.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token) {
    try {
      disconnectTokenSockets(getIO(), token);
    } catch {
      // Socket.IO not initialised (tests/scripts): nothing to disconnect.
    }
  }
  return res.json({ message: "Logged out" });
};

// @desc    The signed-in admin's own profile (name/email/role for the panel UI).
//          Replaces the `user` object the retired /admin/auth/login returned.
// @route   GET /admin/auth/me
// @access  Admin (Supabase token, via authAdmin)
export const getAdminMe = async (req, res) => {
  // try/catch: Express 4 does not catch async rejections, so a DB error here
  // would leave the request (and the admin login button) hanging forever.
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!admin) return res.status(401).json({ message: "Not authorized" });
    return res.json({ user: admin });
  } catch (error) {
    console.error("getAdminMe failed:", error?.message);
    return res.status(500).json({ message: "Server error" });
  }
};
