/**
 * Supabase Auth helpers.
 *
 * Since the 2026-11 auth migration, Supabase owns sign-in for both apps, the
 * vendor portal and the admin panel. This backend no longer issues login
 * tokens: it only verifies the Supabase access token each request carries,
 * then maps it to the Prisma User/Admin row (roles, profiles, approval all
 * stay in Prisma).
 *
 * Verification is local: the token signature is checked against the
 * project's public JWKS (fetched once and cached by jose), plus the issuer
 * and the `authenticated` audience. No network call per request.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

// The project URL is public (it ships inside every client), so a default is
// safe and keeps a missing env var from locking every user out.
export const SUPABASE_URL = (
  process.env.SUPABASE_URL || "https://ruvtpvypjgqzfqfdjguz.supabase.co"
).replace(/\/+$/, "");

const ISSUER = `${SUPABASE_URL}/auth/v1`;

let keyResolver = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

/** Test seam: swap the JWKS resolver (e.g. for jose's createLocalJWKSet). */
export const _setKeyResolverForTests = (resolver) => {
  keyResolver = resolver;
};

/**
 * Verifies a Supabase access token.
 * @param {string} token
 * @returns {Promise<{sub: string, email: string|null, iat: number}>}
 * @throws if the token is missing, forged, expired, or not a user session.
 */
export const verifySupabaseToken = async (token) => {
  if (typeof token !== "string" || !token) throw new Error("missing token");
  const { payload } = await jwtVerify(token, keyResolver, {
    issuer: ISSUER,
    audience: "authenticated",
  });
  // Anonymous sign-ins (if ever switched on) must never map to a real account.
  if (!payload.sub || payload.is_anonymous === true || payload.role !== "authenticated") {
    throw new Error("not a user session");
  }
  return {
    sub: String(payload.sub),
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
    iat: payload.iat,
  };
};

const adminHeaders = () => {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not set");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
};

/**
 * Reads a Supabase user through the Admin API (server-side only).
 * Used before linking a Prisma row by email, to confirm Supabase has really
 * verified that email -- the token alone does not say so.
 */
export const fetchSupabaseUser = async (sub) => {
  const res = await fetch(`${ISSUER}/admin/users/${encodeURIComponent(sub)}`, {
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase admin getUser failed: ${res.status}`);
  return res.json();
};

/** Keeps the Supabase login email in step with a Prisma email change. */
export const updateSupabaseUserEmail = async (sub, email) => {
  const res = await fetch(`${ISSUER}/admin/users/${encodeURIComponent(sub)}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`Supabase admin updateUser failed: ${res.status}`);
  return res.json();
};

/** Removes the Supabase login when an account is erased. */
export const deleteSupabaseUser = async (sub) => {
  const res = await fetch(`${ISSUER}/admin/users/${encodeURIComponent(sub)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Supabase admin deleteUser failed: ${res.status}`);
};
